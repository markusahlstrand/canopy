import { describe, expect, it, beforeEach } from "vitest";
import { createLibsqlDb } from "./db-libsql";
import { runMigrations } from "./schema";
import { createSqlSearchIndex } from "./search";
import { createAiSearchIndex, type AiSearchInstance, type AiSearchResponse } from "./search-ai";
import type { Db } from "./db";

/**
 * The hybrid AI Search adapter (Items-API push model), run against a real
 * in-memory libsql engine (so the fileId → file lookup and the FTS5 leg are
 * both real) with a stubbed AI Search instance standing in for the Cloudflare
 * binding. We assert the parts unique to this adapter: the feed pushes through
 * the Items API, hits resolve to current files, ACL + liveness are enforced by
 * the DB lookup (not the metadata filter), and the two legs fuse.
 */
const SPACE_A = "space-a";
const SPACE_B = "space-b";
const ALL = { spaceIds: [SPACE_A, SPACE_B] };

/** Insert a file row (the unit the fileId lookup resolves). */
async function addFile(
  db: Db,
  opts: { id: string; tenant: string; name: string; metadata?: Record<string, unknown>; deleted?: boolean },
) {
  const now = "2026-01-01T00:00:00.000Z";
  await db.run(
    `INSERT INTO files (id, tenant_id, owner_id, name, current_version_id, metadata, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [opts.id, opts.tenant, "owner", opts.name, null, JSON.stringify(opts.metadata ?? {}), now, now, opts.deleted ? now : null],
  );
}

/** A stub AI Search instance: returns the configured chunks and records feed calls. */
function stubInstance(response: AiSearchResponse) {
  const state = {
    lastFilters: undefined as unknown,
    uploads: [] as { name: string; content: string; metadata?: Record<string, unknown> }[],
    deletes: [] as string[],
  };
  const instance: AiSearchInstance = {
    async search(req) {
      state.lastFilters = req.ai_search_options?.retrieval?.filters;
      return response;
    },
    items: {
      async upload(name, content, opts) {
        state.uploads.push({ name, content, metadata: opts?.metadata });
        return { id: name };
      },
      async delete(id) {
        state.deletes.push(id);
        return {};
      },
    },
  };
  return { instance, state };
}

describe("createAiSearchIndex (hybrid, Items-API push)", () => {
  let db: Db;

  beforeEach(async () => {
    db = createLibsqlDb(":memory:");
    await runMigrations(db);
  });

  it("resolves an AI Search chunk (by fileId) to its current file row", async () => {
    await addFile(db, { id: "f1", tenant: SPACE_A, name: "contract.pdf", metadata: { path: "/legal/contract.pdf" } });
    const fts = createSqlSearchIndex(db);
    const { instance } = stubInstance({
      chunks: [{ score: 0.9, text: "the agreement was signed on...", item: { key: "f1" } }],
    });
    const index = createAiSearchIndex({ db, instance, fts });

    const { items } = await index.query({ text: "agreement" }, ALL);
    expect(items.map((i) => i.id)).toEqual(["f1"]);
    expect(items[0]).toMatchObject({ spaceId: SPACE_A, title: "contract.pdf", kind: "file", path: "/legal/contract.pdf" });
    expect(items[0]!.snippet).toContain("agreement");
  });

  it("enforces ACL via the DB lookup even if AI Search returns out-of-scope hits", async () => {
    await addFile(db, { id: "fa", tenant: SPACE_A, name: "mine.pdf" });
    await addFile(db, { id: "fb", tenant: SPACE_B, name: "theirs.pdf" });
    const fts = createSqlSearchIndex(db);
    // Backend leaks a SPACE_B hit; the DB lookup must drop it when scope is SPACE_A only.
    const { instance } = stubInstance({
      chunks: [
        { score: 0.9, text: "...", item: { key: "fb" } },
        { score: 0.8, text: "...", item: { key: "fa" } },
      ],
    });
    const index = createAiSearchIndex({ db, instance, fts });

    const { items } = await index.query({ text: "anything" }, { spaceIds: [SPACE_A] });
    expect(items.map((i) => i.id)).toEqual(["fa"]);
  });

  it("drops soft-deleted files even if AI Search still has them", async () => {
    await addFile(db, { id: "gone", tenant: SPACE_A, name: "old.pdf", deleted: true });
    const fts = createSqlSearchIndex(db);
    const { instance } = stubInstance({ chunks: [{ score: 0.9, text: "...", item: { key: "gone" } }] });
    const index = createAiSearchIndex({ db, instance, fts });

    const { items } = await index.query({ text: "anything" }, ALL);
    expect(items).toEqual([]);
  });

  it("sends a scoped spaceId metadata filter to AI Search", async () => {
    const fts = createSqlSearchIndex(db);
    const { instance, state } = stubInstance({ chunks: [] });
    const index = createAiSearchIndex({ db, instance, fts });

    await index.query({ text: "q" }, { spaceIds: [SPACE_A] });
    expect(state.lastFilters).toEqual({ spaceId: SPACE_A });
    await index.query({ text: "q" }, ALL);
    expect(state.lastFilters).toEqual({ spaceId: { $in: [SPACE_A, SPACE_B] } });
  });

  it("fuses FTS (filename) and AI Search (content) recall", async () => {
    await addFile(db, { id: "byname", tenant: SPACE_A, name: "quarterly budget.xlsx" });
    await addFile(db, { id: "bycontent", tenant: SPACE_A, name: "notes.txt" });
    const fts = createSqlSearchIndex(db);
    await fts.upsert({ id: "byname", spaceId: SPACE_A, title: "quarterly budget.xlsx", kind: "file" });
    const { instance } = stubInstance({
      chunks: [{ score: 0.95, text: "the budget figures for Q3", item: { key: "bycontent" } }],
    });
    const index = createAiSearchIndex({ db, instance, fts });

    const { items } = await index.query({ text: "budget" }, ALL);
    expect(items.map((i) => i.id).sort()).toEqual(["byname", "bycontent"].sort());
  });

  it("degrades to FTS-only when AI Search throws", async () => {
    await addFile(db, { id: "f1", tenant: SPACE_A, name: "report.txt" });
    const fts = createSqlSearchIndex(db);
    await fts.upsert({ id: "f1", spaceId: SPACE_A, title: "annual report", kind: "file" });
    const instance: AiSearchInstance = {
      async search() {
        throw new Error("binding unavailable");
      },
      items: { async upload() {}, async delete() {} },
    };
    const index = createAiSearchIndex({ db, instance, fts });

    const { items } = await index.query({ text: "annual" }, ALL);
    expect(items.map((i) => i.id)).toEqual(["f1"]);
  });

  it("reads the legacy response shape (data[] + attributes.file.key)", async () => {
    await addFile(db, { id: "f1", tenant: SPACE_A, name: "old.pdf" });
    const fts = createSqlSearchIndex(db);
    const { instance } = stubInstance({
      data: [{ score: 0.7, content: "legacy chunk text", attributes: { file: { key: "f1" } } }],
    });
    const index = createAiSearchIndex({ db, instance, fts });

    const { items } = await index.query({ text: "legacy" }, ALL);
    expect(items.map((i) => i.id)).toEqual(["f1"]);
    expect(items[0]!.snippet).toBe("legacy chunk text");
  });

  it("excludes the AI leg when the caller restricts to non-file kinds", async () => {
    await addFile(db, { id: "f1", tenant: SPACE_A, name: "doc.pdf" });
    const fts = createSqlSearchIndex(db);
    const { instance } = stubInstance({ chunks: [{ score: 0.9, text: "...", item: { key: "f1" } }] });
    const index = createAiSearchIndex({ db, instance, fts });

    const { items } = await index.query({ text: "doc", kinds: ["folder"] }, ALL);
    expect(items).toEqual([]);
  });

  it("upsert pushes content-bearing docs to the Items API and feeds FTS", async () => {
    const fts = createSqlSearchIndex(db);
    const { instance, state } = stubInstance({ chunks: [] });
    const index = createAiSearchIndex({ db, instance, fts });

    await index.upsert({ id: "1", spaceId: SPACE_A, title: "via hybrid", text: "body content here", kind: "file" });
    expect(state.uploads).toHaveLength(1);
    expect(state.uploads[0]).toMatchObject({ name: "1", metadata: { spaceId: SPACE_A } });
    expect(state.uploads[0]!.content).toContain("body content here");
    expect((await fts.query({ text: "hybrid" }, ALL)).items.map((i) => i.id)).toEqual(["1"]);
  });

  it("upsert skips the AI leg for title-only docs (nothing to embed)", async () => {
    const fts = createSqlSearchIndex(db);
    const { instance, state } = stubInstance({ chunks: [] });
    const index = createAiSearchIndex({ db, instance, fts });

    await index.upsert({ id: "fld", spaceId: SPACE_A, title: "My Folder", kind: "folder" });
    expect(state.uploads).toEqual([]);
    // Still indexed lexically.
    expect((await fts.query({ text: "folder" }, ALL)).items.map((i) => i.id)).toEqual(["fld"]);
  });

  it("delete removes from both the Items API and FTS", async () => {
    const fts = createSqlSearchIndex(db);
    const { instance, state } = stubInstance({ chunks: [] });
    const index = createAiSearchIndex({ db, instance, fts });

    await index.upsert({ id: "1", spaceId: SPACE_A, title: "doomed", text: "to be deleted", kind: "file" });
    await index.delete("1");
    expect(state.deletes).toEqual(["1"]);
    expect((await fts.query({ text: "doomed" }, ALL)).items).toEqual([]);
  });
});
