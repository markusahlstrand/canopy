import { describe, expect, it, beforeEach } from "vitest";
import { createLibsqlDb } from "./db-libsql";
import { createSqlBlobRepo } from "./repo";
import { runMigrations } from "./schema";
import { FileService } from "./files";
import { createSqlSearchIndex } from "./search";
import { ensurePersonalSpace } from "./spaces";
import { upsertUser } from "./users";
import { sha256hex } from "./hash";
import type { BlobStore } from "./blob-store";
import type { Db } from "./db";

/**
 * Integration: FileService wired to the SQL search index. Proves the feed (#20)
 * and the ACL-scoped query (#21) end to end against real libsql FTS5 — a file is
 * findable by its body text, name, and metadata, and only within spaces the
 * caller can read.
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

beforeEach(async () => {
  db = createLibsqlDb(":memory:");
  await runMigrations(db);
  store = memStore();
  svc = new FileService(db, store.store, createSqlBlobRepo(db), { index: createSqlSearchIndex(db) });
  await upsertUser(db, { sub: USER, email: "u1@example.com" });
  await upsertUser(db, { sub: OTHER, email: "u2@example.com" });
  space = await ensurePersonalSpace(db, USER);
});

async function upload(name: string, content: string, opts: { path?: string; metadata?: Record<string, unknown> } = {}) {
  const bytes = enc(content);
  const hash = await sha256hex(bytes);
  const prep = await svc.prepareUpload(space, USER, hash);
  if (!prep.exists) await svc.commitUpload(space, USER, hash, bytes);
  return svc.createFile(space, USER, { name, hash, mime: "text/markdown", path: opts.path, metadata: opts.metadata });
}

const ids = (r: { items: { id: string }[] }) => r.items.map((i) => i.id);

describe("FileService search feed", () => {
  it("finds a markdown file by a word that appears only in its body", async () => {
    const f = await upload("meeting-notes.md", "# Notes\n\nThe mitochondria is the powerhouse of the cell.");
    const res = await svc.search(USER, { text: "powerhouse" });
    expect(ids(res)).toEqual([f.id]);
    expect(res.items[0]!.snippet).toContain("powerhouse");
  });

  it("finds a file by its name", async () => {
    const f = await upload("quarterly-budget.md", "nothing relevant inside");
    expect(ids(await svc.search(USER, { text: "budget" }))).toEqual([f.id]);
  });

  it("finds a file by an AI label / tag folded into the index", async () => {
    const f = await upload("scan001.md", "blurry text", { metadata: { labels: ["invoice"], tags: ["urgent"] } });
    expect(ids(await svc.search(USER, { text: "invoice" }))).toEqual([f.id]);
    expect(ids(await svc.search(USER, { text: "urgent" }))).toEqual([f.id]);
  });

  it("enforces ACL: a user who can't see the space gets no results", async () => {
    await upload("private.md", "the powerhouse of the cell");
    await ensurePersonalSpace(db, OTHER);
    expect(await svc.search(OTHER, { text: "powerhouse" })).toEqual({ items: [] });
  });

  it("reflects a content edit: the new body matches, the old word no longer does", async () => {
    const f = await upload("draft.md", "alpha original content");
    const bytes = enc("beta replacement content");
    const hash = await sha256hex(bytes);
    if (!(await svc.prepareUpload(space, USER, hash)).exists) await svc.commitUpload(space, USER, hash, bytes);
    await svc.addVersion({ sub: USER }, f.id, { hash, mime: "text/markdown" });
    expect(ids(await svc.search(USER, { text: "beta" }))).toEqual([f.id]);
    expect(ids(await svc.search(USER, { text: "alpha" }))).toEqual([]);
  });

  it("drops a file from search when it's trashed", async () => {
    const f = await upload("temp.md", "ephemeral powerhouse");
    expect(ids(await svc.search(USER, { text: "ephemeral" }))).toEqual([f.id]);
    await svc.deleteFile({ sub: USER }, f.id);
    expect(ids(await svc.search(USER, { text: "ephemeral" }))).toEqual([]);
  });

  it("backfills pre-existing files via reindexAll", async () => {
    // A service with no index — the file is created but never fed.
    const noIndex = new FileService(db, store.store, createSqlBlobRepo(db));
    const bytes = enc("legacy powerhouse document");
    const hash = await sha256hex(bytes);
    if (!(await noIndex.prepareUpload(space, USER, hash)).exists) await noIndex.commitUpload(space, USER, hash, bytes);
    const f = await noIndex.createFile(space, USER, { name: "legacy.md", hash, mime: "text/markdown" });
    expect(ids(await svc.search(USER, { text: "legacy" }))).toEqual([]); // not yet indexed

    const { indexed } = await svc.reindexAll();
    expect(indexed).toBe(1);
    expect(ids(await svc.search(USER, { text: "legacy" }))).toEqual([f.id]);
  });
});
