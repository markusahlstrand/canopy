import { describe, expect, it, beforeEach } from "vitest";
import { createLibsqlDb } from "./db-libsql";
import { createSqlBlobRepo } from "./repo";
import { runMigrations } from "./schema";
import { FileService } from "./files";
import { addMember, ensurePersonalSpace } from "./spaces";
import { sha256hex } from "./hash";
import type { BlobStore } from "./blob-store";
import type { Db } from "./db";

/**
 * Integration: the per-space change sequence + `changesSince` delta against an
 * in-memory libsql engine, covering ACL scoping, tombstones, bootstrap-vs-delta,
 * the onSpaceChanged nudge, and pagination.
 */

function memStore() {
  const map = new Map<string, Uint8Array>();
  const store: BlobStore = {
    async has(k) {
      return map.has(k);
    },
    async put(k, b) {
      map.set(k, b);
    },
    async get(k) {
      const b = map.get(k);
      return b ? new Response(b as unknown as BodyInit).body : null;
    },
    async delete(k) {
      map.delete(k);
    },
  };
  return { store, map };
}

const USER = "user-1";
const OTHER = "user-2";
const enc = (s: string) => new TextEncoder().encode(s);

let db: Db;
let store: ReturnType<typeof memStore>;
let svc: FileService;
let space: string;
const bumps: { spaceId: string; seq: number }[] = [];

beforeEach(async () => {
  db = createLibsqlDb(":memory:");
  await runMigrations(db);
  store = memStore();
  bumps.length = 0;
  svc = new FileService(db, store.store, createSqlBlobRepo(db), {
    onSpaceChanged: (spaceId, seq) => bumps.push({ spaceId, seq }),
  });
  space = await ensurePersonalSpace(db, USER);
});

async function upload(name: string, content: string, spaceId = space, user = USER, path?: string) {
  const bytes = enc(content);
  const hash = await sha256hex(bytes);
  const prep = await svc.prepareUpload(spaceId, user, hash);
  if (!prep.exists) await svc.commitUpload(spaceId, user, hash, bytes);
  return svc.createFile(spaceId, user, { name, hash, mime: "text/plain", path });
}

describe("changesSince — bootstrap", () => {
  it("returns every live row in the caller's spaces and a cursor at the counter", async () => {
    await upload("a.md", "a");
    await upload("b.md", "b");
    const { changes, cursor, hasMore, spaces } = await svc.changesSince(USER, {});
    expect(changes.map((c) => ("name" in c ? c.name : "")).sort()).toEqual(["a.md", "b.md"]);
    expect(changes.every((c) => !("deleted" in c && c.deleted))).toBe(true);
    expect(cursor[space]).toBe(2); // two creates → counter 2
    expect(hasMore).toBe(false);
    // `kind` must be present — the client resolves the personal drive by it.
    expect(spaces.some((s) => s.id === space && s.role === "owner" && s.kind === "personal")).toBe(true);
  });
});

describe("changesSince — incremental", () => {
  it("returns nothing when the cursor is current, then just the next change", async () => {
    const f = await upload("a.md", "a");
    const boot = await svc.changesSince(USER, {});
    expect(await svc.changesSince(USER, boot.cursor).then((r) => r.changes)).toEqual([]);

    await svc.patchMetadata({ sub: USER }, f.id, { starred: true });
    const delta = await svc.changesSince(USER, boot.cursor);
    expect(delta.changes).toHaveLength(1);
    const [chg] = delta.changes;
    expect(chg && "metadata" in chg && (chg.metadata as { starred?: boolean }).starred).toBe(true);
    expect(delta.cursor[space]).toBe(boot.cursor[space]! + 1);
  });
});

describe("changesSince — tombstones", () => {
  it("surfaces a soft delete as a tombstone in the delta", async () => {
    const f = await upload("a.md", "a");
    const boot = await svc.changesSince(USER, {});
    await svc.deleteFile({ sub: USER }, f.id);
    const delta = await svc.changesSince(USER, boot.cursor);
    expect(delta.changes).toEqual([expect.objectContaining({ id: f.id, deleted: true })]);
  });

  it("surfaces a hard delete (purge) via the tombstones table", async () => {
    const f = await upload("a.md", "a");
    const boot = await svc.changesSince(USER, {});
    await svc.purgeFile({ sub: USER }, f.id);
    const delta = await svc.changesSince(USER, boot.cursor);
    expect(delta.changes).toEqual([expect.objectContaining({ id: f.id, deleted: true })]);
  });

  it("does NOT include soft-deleted rows in a bootstrap (only live rows)", async () => {
    const f = await upload("a.md", "a");
    await svc.deleteFile({ sub: USER }, f.id);
    const boot = await svc.changesSince(USER, {});
    expect(boot.changes).toEqual([]);
  });
});

describe("changesSince — ACL scoping", () => {
  it("never returns another user's personal-space files", async () => {
    await ensurePersonalSpace(db, OTHER);
    await upload("mine.md", "x"); // in USER's personal space
    const other = await svc.changesSince(OTHER, {});
    expect(other.changes).toEqual([]);
    expect(other.spaces.some((s) => s.id === space)).toBe(false);
  });

  it("returns a shared group space's files to a member", async () => {
    const group = await svc.createSpace({ sub: USER, email: "" }, { name: "Fam" });
    await addMember(db, group.id, OTHER, "editor");
    await upload("shared.md", "x", group.id);
    const seen = await svc.changesSince(OTHER, {});
    expect(seen.changes.map((c) => ("name" in c ? c.name : ""))).toContain("shared.md");
    expect(seen.spaces.some((s) => s.id === group.id)).toBe(true);
  });
});

describe("changesSince — connected spaces are mirrored too", () => {
  it("includes a connected space in scope (with kind), so the client can mirror it", async () => {
    await upload("a.md", "a"); // personal space
    const conn = await svc.ensureConnectorSpace(USER, "synology", "NAS");
    const { spaces } = await svc.changesSince(USER, {});
    expect(spaces.some((s) => s.id === conn && s.kind === "connected")).toBe(true);
  });
});

describe("onSpaceChanged nudge", () => {
  it("fires with the space id and current seq on every mutation", async () => {
    const f = await upload("a.md", "a");
    expect(bumps.at(-1)).toEqual({ spaceId: space, seq: 1 });
    await svc.patchMetadata({ sub: USER }, f.id, { starred: true });
    expect(bumps.at(-1)).toEqual({ spaceId: space, seq: 2 });
  });
});

describe("changesSince — pagination", () => {
  it("caps a page and reports hasMore, resuming exactly where it stopped", async () => {
    for (let i = 0; i < 5; i++) await upload(`f${i}.md`, String(i));
    const first = await svc.changesSince(USER, {}, 3);
    expect(first.changes).toHaveLength(3);
    expect(first.hasMore).toBe(true);
    const second = await svc.changesSince(USER, first.cursor, 3);
    expect(second.changes).toHaveLength(2);
    expect(second.hasMore).toBe(false);
    // No row appears in both pages.
    const ids = new Set(first.changes.map((c) => c.id));
    expect(second.changes.some((c) => ids.has(c.id))).toBe(false);
  });
});
