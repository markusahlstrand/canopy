import type { Db } from "./db";

/**
 * SQLite/D1-backed full-text {@link SearchIndex} over the `search_index` FTS5
 * table (migration v16) — the portable backend that works identically on libsql
 * (local) and D1 (Cloudflare), like `createSqlCacheStore`. Structurally
 * implements `@canopy/core`'s `SearchIndex` (kept import-free so the store stays
 * core-independent); the host wires this into the `SearchIndex` slot, where TS
 * structural typing checks the shapes line up.
 *
 * Feeding is trusted I/O, so a doc carries its own `spaceId`. Querying is
 * ACL-bound: every query is constrained to the caller's readable spaces, passed
 * in by the host as `scope.spaceIds` — never taken from the (sandboxed) query.
 */
export function createSqlSearchIndex(db: Db) {
  return {
    async upsert(docs: SearchDoc | SearchDoc[]): Promise<void> {
      const list = Array.isArray(docs) ? docs : [docs];
      if (list.length === 0) return;
      // FTS5 virtual tables can't ON CONFLICT, so upsert is delete-then-insert
      // by id, run as one atomic batch.
      const statements: { sql: string; params: unknown[] }[] = [];
      for (const d of list) {
        statements.push({ sql: "DELETE FROM search_index WHERE id = ?", params: [d.id] });
        statements.push({
          sql: `INSERT INTO search_index
                  (id, space_id, kind, path, connector_id, modified_at, metadata, title, text)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            d.id,
            d.spaceId,
            d.kind ?? null,
            d.path ?? null,
            d.connectorId ?? null,
            d.modifiedAt ?? null,
            d.metadata ? JSON.stringify(d.metadata) : null,
            d.title,
            d.text ?? "",
          ],
        });
      }
      await db.batch(statements);
    },

    async delete(ids: string | string[]): Promise<void> {
      const list = Array.isArray(ids) ? ids : [ids];
      if (list.length === 0) return;
      const holes = list.map(() => "?").join(",");
      await db.run(`DELETE FROM search_index WHERE id IN (${holes})`, list);
    },

    async query(query: SearchQuery, scope: SearchScope): Promise<Page<SearchHit>> {
      const match = toMatchExpr(query.text);
      // Empty scope matches nothing; a blank query has nothing to match. Both
      // short-circuit so we never emit `MATCH ''` (an FTS5 error) or an
      // unscoped scan.
      if (match === null || scope.spaceIds.length === 0) return { items: [] };

      const where = ["search_index MATCH ?", `space_id IN (${scope.spaceIds.map(() => "?").join(",")})`];
      const params: unknown[] = [match, ...scope.spaceIds];

      if (query.kinds?.length) {
        where.push(`kind IN (${query.kinds.map(() => "?").join(",")})`);
        params.push(...query.kinds);
      }
      for (const [key, value] of Object.entries(query.filter ?? {})) {
        where.push("json_extract(metadata, ?) = ?");
        params.push(`$.${key}`, typeof value === "boolean" ? (value ? 1 : 0) : (value as unknown));
      }

      const limit = clampLimit(query.limit);
      const offset = parseCursor(query.cursor);

      // `text` is the last declared column (index 8) — the one we snippet.
      // bm25() is more-negative for better matches, so negate it for a
      // higher-is-better `score` and order ascending.
      const rows = await db.all<Row>(
        `SELECT id, space_id AS spaceId, kind, path, modified_at AS modifiedAt, title,
                snippet(search_index, 8, '[', ']', '…', 12) AS snippet,
                bm25(search_index) AS rank
           FROM search_index
          WHERE ${where.join(" AND ")}
          ORDER BY rank
          LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      );

      const items: SearchHit[] = rows.map((r) => ({
        id: r.id,
        spaceId: r.spaceId,
        score: -(r.rank ?? 0),
        title: r.title,
        snippet: r.snippet ? r.snippet : undefined,
        kind: r.kind ?? undefined,
        path: r.path ?? undefined,
        modifiedAt: r.modifiedAt ?? undefined,
      }));

      // More may exist only if this page filled to the limit.
      const cursor = items.length === limit ? String(offset + limit) : undefined;
      return { items, cursor };
    },
  };
}

export type SqlSearchIndex = ReturnType<typeof createSqlSearchIndex>;

/** Row shape returned by the query SELECT (column aliases). */
interface Row {
  id: string;
  spaceId: string;
  kind: string | null;
  path: string | null;
  modifiedAt: string | null;
  title: string;
  snippet: string | null;
  rank: number | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function clampLimit(limit?: number): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function parseCursor(cursor?: string): number {
  const n = cursor ? Number(cursor) : 0;
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Turn free user text into a safe FTS5 MATCH expression: extract word tokens,
 * quote each (neutralizing FTS5 operators so arbitrary input can't error), AND
 * them implicitly, and prefix-match the final token for type-ahead. Returns
 * null when there's nothing to match.
 */
function toMatchExpr(text: string): string | null {
  const terms = text.match(/[\p{L}\p{N}]+/gu);
  if (!terms || terms.length === 0) return null;
  return terms.map((t, i) => `"${t}"${i === terms.length - 1 ? "*" : ""}`).join(" ");
}

// --- Structural mirror of `@canopy/core`'s SearchIndex types --------------
// Duplicated (not imported) so this package stays core-independent; the host
// proves the shapes match when it assigns this adapter to the core slot.

interface Page<T> {
  items: T[];
  cursor?: string;
}

interface SearchDoc {
  id: string;
  spaceId: string;
  title: string;
  text?: string;
  kind?: string;
  path?: string;
  connectorId?: string;
  modifiedAt?: string;
  metadata?: Record<string, unknown>;
}

interface SearchQuery {
  text: string;
  kinds?: string[];
  filter?: Record<string, unknown>;
  limit?: number;
  cursor?: string;
}

interface SearchScope {
  spaceIds: string[];
}

interface SearchHit {
  id: string;
  spaceId: string;
  score: number;
  title: string;
  snippet?: string;
  kind?: string;
  path?: string;
  modifiedAt?: string;
}
