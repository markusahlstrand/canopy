import { describe, expect, it, beforeEach } from "vitest";
import { createLibsqlDb } from "./db-libsql";
import { createSqlBlobRepo } from "./repo";
import { runMigrations } from "./schema";
import { FileService, PermissionError } from "./files";
import { ensurePersonalSpace, createSpace, addMember } from "./spaces";
import type { BlobStore } from "./blob-store";
import type { Db } from "./db";

/**
 * Share links — the capability semantics: a secret resolves (as its creator) to
 * a scoped role, the link's role is capped by the creator's own role, and
 * revoke/expiry end it.
 */

function memStore(): BlobStore {
  const map = new Map<string, Uint8Array>();
  return {
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
}

const OWNER = "owner-1";
const VIEWER = "viewer-1";
const owner = { sub: OWNER };
const viewer = { sub: VIEWER };
const enc = (s: string) => new TextEncoder().encode(s);

let db: Db;
let svc: FileService;
let space: string;

beforeEach(async () => {
  db = createLibsqlDb(":memory:");
  await runMigrations(db);
  svc = new FileService(db, memStore(), createSqlBlobRepo(db));
  space = await ensurePersonalSpace(db, OWNER);
});

describe("createShare + verifyShare", () => {
  it("resolves a file share to its capability (as the creator)", async () => {
    await svc.putByPath(space, OWNER, "Docs/notes.txt", enc("hi"));
    const file = await svc.getByPath(OWNER, space, "Docs/notes.txt");
    const { secret } = await svc.createShare(owner, { objectType: "file", fileId: file!.id }, { role: "editor" });

    const v = await svc.verifyShare(secret);
    expect(v).toMatchObject({ objectType: "file", fileId: file!.id, role: "editor", createdBy: OWNER, spaceId: space });
  });

  it("resolves folder and space shares", async () => {
    const folder = await svc.createShare(owner, { objectType: "folder", spaceId: space, path: "Docs" }, { role: "viewer" });
    const whole = await svc.createShare(owner, { objectType: "space", spaceId: space }, { role: "viewer" });

    expect(await svc.verifyShare(folder.secret)).toMatchObject({ objectType: "folder", path: "Docs", spaceId: space });
    expect(await svc.verifyShare(whole.secret)).toMatchObject({ objectType: "space", spaceId: space });
  });

  it("returns null for an unknown secret", async () => {
    expect(await svc.verifyShare("nope")).toBe(null);
    expect(await svc.verifyShare("")).toBe(null);
  });
});

describe("role cap", () => {
  it("lets a space viewer mint a view link but not an edit link", async () => {
    const group = await createSpace(db, { name: "Family", createdBy: OWNER });
    await addMember(db, group.id, VIEWER, "viewer");

    // A viewer can hand out their own (view) access…
    const ok = await svc.createShare(viewer, { objectType: "space", spaceId: group.id }, { role: "viewer" });
    expect(await svc.verifyShare(ok.secret)).toMatchObject({ role: "viewer" });

    // …but cannot escalate to a read-write link.
    await expect(svc.createShare(viewer, { objectType: "space", spaceId: group.id }, { role: "editor" })).rejects.toBeInstanceOf(
      PermissionError,
    );
  });
});

describe("revoke + expiry", () => {
  it("stops resolving once revoked, and drops out of the listing", async () => {
    const { id, secret } = await svc.createShare(owner, { objectType: "space", spaceId: space }, { role: "viewer" });
    expect(await svc.verifyShare(secret)).not.toBe(null);
    expect((await svc.listShares(owner, { objectType: "space", spaceId: space })).length).toBe(1);

    await svc.revokeShare(owner, id);
    expect(await svc.verifyShare(secret)).toBe(null);
    expect((await svc.listShares(owner, { objectType: "space", spaceId: space })).length).toBe(0);
  });

  it("stops resolving once expired", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const { secret } = await svc.createShare(owner, { objectType: "space", spaceId: space }, { role: "viewer", expiresAt: past });
    expect(await svc.verifyShare(secret)).toBe(null);
  });
});
