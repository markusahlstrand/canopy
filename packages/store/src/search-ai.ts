import type { Db } from "./db";

/**
 * A hybrid {@link SearchIndex} backed by Cloudflare AI Search (formerly AutoRAG)
 * for semantic *content* relevance, fused with the SQL/D1 FTS5 index
 * ({@link createSqlSearchIndex}) for *lexical* (filename / exact-term / metadata)
 * matching.
 *
 * Indexing is **push-based and source-independent**: rather than pointing AI
 * Search at an R2 bucket and letting it scan, we feed it through its Items API
 * from the same trusted in-process feed that drives FTS. So `upsert(doc)` uploads
 * the *composed* text (filename + extracted body + description + labels + tags —
 * exactly what FTS sees) and `delete(id)` removes it, for every file regardless
 * of where its bytes live (R2 blob, GitHub, Synology…). That means: AI Search
 * sees canopy's curated text (not just raw bytes), connector-backed spaces are
 * covered uniformly, indexing is per-item (no multi-hour bucket-scan lag), and
 * hits carry our own `fileId` back — no blob-key reverse-map.
 *
 * Access control is layered. Every query is sent with a `spaceId` metadata
 * filter so AI Search only retrieves the caller's spaces, but the authoritative
 * boundary is the by-id DB lookup in `aiQuery`: it re-checks `tenant_id` against
 * the scope and drops anything soft-deleted, so a stale or mis-filtered AI hit
 * can never surface a file the caller can't (currently) read. The same lookup
 * supplies the always-current title/path/modifiedAt for display.
 *
 * The two legs fuse with reciprocal-rank fusion (their raw scores aren't
 * comparable). The AI leg is best-effort throughout: an upload, delete, or query
 * failure degrades to FTS-only and never fails the operation — FTS remains the
 * source of truth for freshness and lexical recall.
 *
 * Structurally implements `@canopy/core`'s `SearchIndex` (kept import-free so
 * the store stays core-independent); the host wires it into the `SearchIndex`
 * slot where TS structural typing checks the shapes line up.
 */
export function createAiSearchIndex(opts: AiSearchIndexOptions) {
  const { db, instance, fts } = opts;

  return {
    async upsert(docs: SearchDoc | SearchDoc[]): Promise<void> {
      const list = Array.isArray(docs) ? docs : [docs];
      if (list.length === 0) return;
      // FTS is the lexical leg + zero-lag freshness; always fed, authoritative.
      await fts.upsert(list);
      // Push content-bearing docs to AI Search for semantic recall. Best-effort.
      await Promise.all(
        list.map(async (d) => {
          try {
            // Only files with a body embed usefully. A title-only doc (a folder,
            // or a file whose body hasn't been extracted yet — or was *removed*)
            // must not stay in the index: purge any prior item so stale chunks
            // can't keep producing hits/snippets after content disappears.
            if (!d.text?.trim()) {
              await deleteAiItem(db, instance, d.id);
              return;
            }
            const content = [d.title, d.text].filter(Boolean).join("\n");
            const prev = await getAiItemId(db, d.id);
            const { id: itemId } = await instance.items.upload(d.id, content, {
              metadata: { spaceId: d.spaceId },
            });
            await setAiItemId(db, d.id, itemId);
            // The Items API keys by name but mints a fresh `id` per upload; if a
            // re-upload didn't overwrite in place, drop the superseded item.
            if (prev && prev !== itemId) await safeDelete(instance, prev);
          } catch (err) {
            console.warn(`[search] ai-search upload failed for ${d.id}: ${(err as Error).message}`);
          }
        }),
      );
    },

    async delete(ids: string | string[]): Promise<void> {
      const list = Array.isArray(ids) ? ids : [ids];
      if (list.length === 0) return;
      await fts.delete(list);
      // Best-effort index hygiene only: the by-id liveness check in `aiQuery`
      // already prevents a deleted file from surfacing even if this never runs.
      await Promise.all(
        list.map(async (id) => {
          try {
            await deleteAiItem(db, instance, id);
          } catch (err) {
            console.warn(`[search] ai-search delete failed for ${id}: ${(err as Error).message}`);
          }
        }),
      );
    },

    async query(query: SearchQuery, scope: SearchScope): Promise<Page<SearchHit>> {
      if (scope.spaceIds.length === 0) return { items: [] };
      const limit = clampLimit(query.limit);

      // Both backends in parallel; a flaky AI Search call degrades to FTS-only
      // rather than failing the search (see `aiQuery`'s try/catch).
      const [ftsPage, aiHits] = await Promise.all([
        fts.query(query, scope),
        aiQuery(db, instance, query, scope, limit),
      ]);

      // Reciprocal-rank fusion: a doc's fused score is the sum of 1/(k+rank)
      // across the lists it appears in, so agreement between the two backends
      // floats a hit to the top without needing comparable raw scores.
      const fused = new Map<string, { hit: SearchHit; score: number }>();
      const fuse = (hits: SearchHit[]) => {
        hits.forEach((hit, i) => {
          const add = 1 / (RRF_K + i + 1);
          const prev = fused.get(hit.id);
          if (prev) {
            prev.score += add;
            // Prefer a snippet from whichever backend produced one (AI Search's
            // is a content chunk; FTS's is a title/metadata excerpt).
            if (!prev.hit.snippet && hit.snippet) prev.hit.snippet = hit.snippet;
          } else {
            fused.set(hit.id, { hit: { ...hit }, score: add });
          }
        });
      };
      fuse(ftsPage.items);
      fuse(aiHits);

      const items = [...fused.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ hit, score }) => ({ ...hit, score }));

      // No cursor: a fused ranking over two backends with no shared offset model
      // isn't stably pageable. Callers raise `limit` instead of paging.
      return { items };
    },
  };
}

export type AiSearchIndex = ReturnType<typeof createAiSearchIndex>;

export interface AiSearchIndexOptions {
  /** Metadata DB: resolves AI Search hits (by fileId) → current file rows, and
   *  is the authoritative ACL + liveness boundary. */
  db: Db;
  /** The Cloudflare AI Search instance binding (e.g. `env.AI_SEARCH.get(name)`). */
  instance: AiSearchInstance;
  /** The SQL/D1 FTS index — the lexical leg and source of truth for freshness. */
  fts: SearchIndex;
}

/**
 * Run the AI Search leg: semantic query → resolve hit fileIds → current,
 * in-scope, live file rows (the authoritative ACL/liveness gate + display data).
 */
async function aiQuery(
  db: Db,
  instance: AiSearchInstance,
  query: SearchQuery,
  scope: SearchScope,
  limit: number,
): Promise<SearchHit[]> {
  // The AI leg indexes content-bearing files only. If the caller restricts to
  // other kinds (e.g. ["folder"]), it can't contribute.
  if (query.kinds?.length && !query.kinds.includes("file")) return [];
  if (!query.text.trim()) return [];

  let res: AiSearchResponse;
  try {
    res = await instance.search({
      query: query.text,
      ai_search_options: {
        retrieval: {
          // Over-fetch a little: chunks dedupe to fewer files, and some may be
          // dropped by the liveness/scope gate, so ask for more than `limit`.
          max_num_results: Math.min(AI_MAX_RESULTS, Math.max(limit * 3, limit)),
          filters: scopeFilter(scope),
        },
      },
    });
  } catch (err) {
    // Best-effort: a search hiccup degrades to FTS-only, never fails the query.
    console.warn(`[search] ai-search query failed: ${(err as Error).message}`);
    return [];
  }

  // The AI Search response shape has shifted across versions (chunks/data,
  // item/attributes) — read defensively. Guard the array type too: a malformed
  // payload must degrade to FTS-only, not throw mid-iteration.
  const chunks = Array.isArray(res.chunks) ? res.chunks : Array.isArray(res.data) ? res.data : [];
  if (chunks.length === 0) return [];

  // Keep the best-scoring chunk per file id, preserving first-seen order so the
  // backend's own ranking carries into the RRF rank.
  const byId = new Map<string, { score: number; snippet?: string; order: number }>();
  let order = 0;
  for (const c of chunks) {
    const id = chunkFileId(c);
    if (!id) continue;
    const score = typeof c.score === "number" ? c.score : 0;
    const snippet = chunkText(c);
    const prev = byId.get(id);
    if (!prev) byId.set(id, { score, snippet, order: order++ });
    else if (score > prev.score) byId.set(id, { score, snippet: snippet ?? prev.snippet, order: prev.order });
  }
  if (byId.size === 0) return [];

  // Resolve fileIds → current file rows, scoped to the caller's spaces and not
  // soft-deleted. This is the authoritative ACL + liveness boundary (the AI-side
  // metadata filter above is only a cost/recall optimization on top).
  const ids = [...byId.keys()];
  const rows = await db.all<FileRow>(
    `SELECT id, tenant_id AS spaceId, name AS title, updated_at AS modifiedAt, metadata
       FROM files
      WHERE id IN (${ids.map(() => "?").join(",")})
        AND tenant_id IN (${scope.spaceIds.map(() => "?").join(",")})
        AND deleted_at IS NULL`,
    [...ids, ...scope.spaceIds],
  );

  const hits: { hit: SearchHit; order: number }[] = [];
  for (const r of rows) {
    const m = byId.get(r.id);
    if (!m) continue;
    const meta = parseMeta(r.metadata);
    // Mirror the FTS adapter's equality filter over indexed metadata fields.
    if (!matchesFilter(meta, query.filter)) continue;
    hits.push({
      order: m.order,
      hit: {
        id: r.id,
        spaceId: r.spaceId,
        score: m.score,
        title: r.title,
        snippet: m.snippet,
        kind: "file",
        path: typeof meta.path === "string" ? meta.path : undefined,
        modifiedAt: r.modifiedAt ?? undefined,
      },
    });
  }
  return hits.sort((a, b) => a.order - b.order).map((h) => h.hit);
}

/**
 * Restrict AI Search to the caller's spaces via the `spaceId` custom-metadata
 * field we stamp on every uploaded item. Vectorize-style `$in` (the current AI
 * Search filter format). Purely an optimization — the DB lookup is what enforces
 * ACL — so if the backend ignores or rejects it, results are still scoped.
 *
 * Note: `spaceId` must be declared as a custom metadata attribute on the AI
 * Search instance for the filter to apply.
 */
function scopeFilter(scope: SearchScope): Record<string, unknown> {
  return scope.spaceIds.length === 1 ? { spaceId: scope.spaceIds[0] } : { spaceId: { $in: scope.spaceIds } };
}

/** Our uploaded item name is the file id; read it back defensively across shapes. */
function chunkFileId(c: AiSearchChunk): string | undefined {
  return (
    c.item?.key ??
    c.attributes?.file?.key ??
    c.filename ??
    (typeof c.item?.metadata?.fileId === "string" ? c.item.metadata.fileId : undefined) ??
    undefined
  );
}

function chunkText(c: AiSearchChunk): string | undefined {
  if (typeof c.text === "string" && c.text) return c.text;
  if (typeof c.content === "string" && c.content) return c.content;
  if (Array.isArray(c.content)) {
    const joined = c.content.map((p) => p?.text ?? "").filter(Boolean).join(" ");
    if (joined) return joined;
  }
  return undefined;
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function matchesFilter(meta: Record<string, unknown>, filter?: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(filter ?? {})) {
    if (meta[key] !== value) return false;
  }
  return true;
}

// --- AI Search item map (fileId → the opaque itemId `upload()` returns) -----
// `items.delete()`/`items.get()` only accept that itemId — there is no
// delete-by-name — so we persist it on upload and resolve it back here.

async function getAiItemId(db: Db, fileId: string): Promise<string | undefined> {
  const row = await db.first<{ item_id: string }>("SELECT item_id FROM ai_search_items WHERE file_id = ?", [fileId]);
  return row?.item_id;
}

async function setAiItemId(db: Db, fileId: string, itemId: string): Promise<void> {
  await db.run(
    `INSERT INTO ai_search_items (file_id, item_id) VALUES (?, ?)
       ON CONFLICT(file_id) DO UPDATE SET item_id = excluded.item_id`,
    [fileId, itemId],
  );
}

/** Delete the AI Search item mapped to `fileId` (if any) and drop the mapping. */
async function deleteAiItem(db: Db, instance: AiSearchInstance, fileId: string): Promise<void> {
  const itemId = await getAiItemId(db, fileId);
  if (!itemId) return;
  await safeDelete(instance, itemId);
  await db.run("DELETE FROM ai_search_items WHERE file_id = ?", [fileId]);
}

/** Delete an item by its itemId, swallowing failure so cleanup stays idempotent
 *  and best-effort (a stale chunk can't surface — `aiQuery` re-checks liveness). */
async function safeDelete(instance: AiSearchInstance, itemId: string): Promise<void> {
  try {
    await instance.items.delete(itemId);
  } catch (err) {
    console.warn(`[search] ai-search item delete failed for ${itemId}: ${(err as Error).message}`);
  }
}

const RRF_K = 60;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const AI_MAX_RESULTS = 50; // AI Search `max_num_results` ceiling

function clampLimit(limit?: number): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

/** Row shape from the fileId → file lookup. */
interface FileRow {
  id: string;
  spaceId: string;
  title: string;
  modifiedAt: string | null;
  metadata: string | null;
}

// --- Duck-typed slice of the Cloudflare AI Search binding ------------------
// Kept structural (no @cloudflare/workers-types dep); the real binding —
// `env.AI_SEARCH.get(name)` — satisfies it.

/** A single AI Search instance: the `.search()` (retrieval) + `.items` (feed) surfaces we use. */
export interface AiSearchInstance {
  search(opts: AiSearchRequest): Promise<AiSearchResponse>;
  items: AiSearchItems;
}

/** The built-in-storage Items API: push documents into the instance directly. */
export interface AiSearchItems {
  /** Upload an item under `name` (we use the fileId); `content` is the text to
   *  index. Returns the opaque `id` that `delete()`/`get()` require. Queued for processing. */
  upload(name: string, content: string, opts?: { metadata?: Record<string, unknown> }): Promise<{ id: string; key?: string }>;
  /** Remove an item by the `id` returned from {@link upload} (not the upload name). */
  delete(id: string): Promise<unknown>;
}

export interface AiSearchRequest {
  query: string;
  ai_search_options?: {
    retrieval?: {
      max_num_results?: number;
      filters?: Record<string, unknown>;
    };
  };
}

export interface AiSearchResponse {
  /** Current shape. */
  chunks?: AiSearchChunk[];
  /** Legacy shape (older AutoRAG API). */
  data?: AiSearchChunk[];
}

export interface AiSearchChunk {
  score?: number;
  text?: string;
  content?: string | { text?: string }[];
  /** Current shape: the source object (its `key` is our uploaded item name = fileId). */
  item?: { key?: string; metadata?: Record<string, unknown> };
  /** Legacy shape: nested under attributes.file. */
  attributes?: { file?: { key?: string } };
  /** Oldest shape: bare filename/key. */
  filename?: string;
}

// --- Structural mirror of `@canopy/core`'s SearchIndex types --------------
// Duplicated (not imported) so this package stays core-independent.

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

interface SearchIndex {
  upsert(docs: SearchDoc | SearchDoc[]): Promise<void>;
  delete(ids: string | string[]): Promise<void>;
  query(query: SearchQuery, scope: SearchScope): Promise<Page<SearchHit>>;
}
