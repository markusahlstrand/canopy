import { describe, expect, it, beforeEach } from "vitest";
import { createLibsqlDb } from "./db-libsql";
import { runMigrations } from "./schema";
import { createSqlSearchIndex } from "./search";

/**
 * The SearchIndex contract — the behaviour *every* adapter must satisfy,
 * factored out so a future backend (D1 is the same SQL path; Vectorize would be
 * separate) is held to the same spec. Run against an in-memory libsql engine so
 * real FTS5 MATCH / bm25 / snippet / json_extract are exercised.
 */
function searchIndexContract(name: string, makeIndex: () => Promise<ReturnType<typeof createSqlSearchIndex>>) {
  describe(`SearchIndex contract: ${name}`, () => {
    let index: ReturnType<typeof createSqlSearchIndex>;
    const SPACE_A = "space-a";
    const SPACE_B = "space-b";
    const ALL = { spaceIds: [SPACE_A, SPACE_B] };

    beforeEach(async () => {
      index = await makeIndex();
    });

    it("indexes a doc and finds it by a word in the title", async () => {
      await index.upsert({ id: "1", spaceId: SPACE_A, title: "Quarterly budget spreadsheet" });
      const { items } = await index.query({ text: "budget" }, ALL);
      expect(items.map((i) => i.id)).toEqual(["1"]);
      expect(items[0]).toMatchObject({ spaceId: SPACE_A, title: "Quarterly budget spreadsheet" });
      expect(items[0]!.score).toBeGreaterThan(0);
    });

    it("matches body text and returns a highlighted snippet", async () => {
      await index.upsert({ id: "1", spaceId: SPACE_A, title: "Notes", text: "the mitochondria is the powerhouse of the cell" });
      const { items } = await index.query({ text: "powerhouse" }, ALL);
      expect(items).toHaveLength(1);
      expect(items[0]!.snippet).toContain("[powerhouse]");
    });

    it("enforces ACL: never returns docs outside the query scope", async () => {
      await index.upsert([
        { id: "a", spaceId: SPACE_A, title: "shared recipe" },
        { id: "b", spaceId: SPACE_B, title: "secret recipe" },
      ]);
      const { items } = await index.query({ text: "recipe" }, { spaceIds: [SPACE_A] });
      expect(items.map((i) => i.id)).toEqual(["a"]);
    });

    it("returns nothing for an empty scope", async () => {
      await index.upsert({ id: "1", spaceId: SPACE_A, title: "anything" });
      const { items } = await index.query({ text: "anything" }, { spaceIds: [] });
      expect(items).toEqual([]);
    });

    it("returns nothing for a blank query without erroring", async () => {
      await index.upsert({ id: "1", spaceId: SPACE_A, title: "anything" });
      expect((await index.query({ text: "   " }, ALL)).items).toEqual([]);
      expect((await index.query({ text: "!!!" }, ALL)).items).toEqual([]);
    });

    it("upsert is idempotent — re-feeding an id overwrites, no duplicate", async () => {
      await index.upsert({ id: "1", spaceId: SPACE_A, title: "draft title" });
      await index.upsert({ id: "1", spaceId: SPACE_A, title: "final title" });
      const draft = await index.query({ text: "draft" }, ALL);
      const final = await index.query({ text: "final" }, ALL);
      expect(draft.items).toHaveLength(0);
      expect(final.items.map((i) => i.id)).toEqual(["1"]);
    });

    it("delete removes a doc", async () => {
      await index.upsert([
        { id: "1", spaceId: SPACE_A, title: "keep me apple" },
        { id: "2", spaceId: SPACE_A, title: "delete me apple" },
      ]);
      await index.delete("2");
      const { items } = await index.query({ text: "apple" }, ALL);
      expect(items.map((i) => i.id)).toEqual(["1"]);
    });

    it("filters by kind", async () => {
      await index.upsert([
        { id: "f", spaceId: SPACE_A, title: "report alpha", kind: "file" },
        { id: "d", spaceId: SPACE_A, title: "report alpha", kind: "folder" },
      ]);
      const { items } = await index.query({ text: "report", kinds: ["file"] }, ALL);
      expect(items.map((i) => i.id)).toEqual(["f"]);
    });

    it("filters by an indexed metadata field", async () => {
      await index.upsert([
        { id: "1", spaceId: SPACE_A, title: "invoice march", metadata: { status: "paid" } },
        { id: "2", spaceId: SPACE_A, title: "invoice april", metadata: { status: "due" } },
      ]);
      const { items } = await index.query({ text: "invoice", filter: { status: "due" } }, ALL);
      expect(items.map((i) => i.id)).toEqual(["2"]);
    });

    it("ranks better matches higher", async () => {
      await index.upsert([
        { id: "strong", spaceId: SPACE_A, title: "canopy canopy canopy" },
        { id: "weak", spaceId: SPACE_A, title: "canopy and other words here" },
      ]);
      const { items } = await index.query({ text: "canopy" }, ALL);
      expect(items[0]!.id).toBe("strong");
      expect(items[0]!.score).toBeGreaterThanOrEqual(items[1]!.score);
    });

    it("prefix-matches the final term for type-ahead", async () => {
      await index.upsert({ id: "1", spaceId: SPACE_A, title: "photography portfolio" });
      const { items } = await index.query({ text: "photog" }, ALL);
      expect(items.map((i) => i.id)).toEqual(["1"]);
    });

    it("folds diacritics", async () => {
      await index.upsert({ id: "1", spaceId: SPACE_A, title: "Mon résumé" });
      const { items } = await index.query({ text: "resume" }, ALL);
      expect(items.map((i) => i.id)).toEqual(["1"]);
    });

    it("paginates with the opaque cursor", async () => {
      await index.upsert(
        Array.from({ length: 5 }, (_, i) => ({ id: `doc-${i}`, spaceId: SPACE_A, title: `widget number ${i}` })),
      );
      const first = await index.query({ text: "widget", limit: 2 }, ALL);
      expect(first.items).toHaveLength(2);
      expect(first.cursor).toBeDefined();

      const second = await index.query({ text: "widget", limit: 2, cursor: first.cursor }, ALL);
      expect(second.items).toHaveLength(2);
      // No overlap between pages.
      const firstIds = new Set(first.items.map((i) => i.id));
      expect(second.items.some((i) => firstIds.has(i.id))).toBe(false);

      const third = await index.query({ text: "widget", limit: 2, cursor: second.cursor }, ALL);
      expect(third.items).toHaveLength(1);
      expect(third.cursor).toBeUndefined();
    });
  });
}

searchIndexContract("libsql FTS5", async () => {
  const db = createLibsqlDb(":memory:");
  await runMigrations(db);
  return createSqlSearchIndex(db);
});
