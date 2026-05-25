import type { Page } from "./storage";

/**
 * A core-queryable search index, implemented by swappable backends:
 *   - libsql / SQLite FTS5 — portable, the default on Node / dev / Docker;
 *   - D1 FTS or Cloudflare Vectorize — on the edge;
 *   - an external managed-search service — just another adapter.
 *
 * The host picks a backend per environment; call sites and plugins only see
 * this interface — exactly like `StorageConnector` and `CacheStore`. The index
 * is a derived cache, never the source of truth: it is *fed* by trusted,
 * in-process connectors and processors (the feed side) and *queried* by plugins
 * through a scoped `queryIndex()` grant (the query side).
 *
 * The two sides are deliberately asymmetric on access control. Feeding is
 * trusted I/O, so a `SearchDoc` carries its own `spaceId`. Querying is
 * sandboxed, so the caller's readable spaces are NOT part of the plugin-facing
 * `SearchQuery` — the host resolves them and passes them as a separate
 * `SearchScope`. A plugin can never widen its own scope.
 */
export interface SearchIndex {
  /**
   * Insert or replace documents, keyed by `SearchDoc.id`. Idempotent: feeding
   * the same id again overwrites the previous version.
   */
  upsert(docs: SearchDoc | SearchDoc[]): Promise<void>;
  /** Remove documents by id. Unknown ids are ignored. */
  delete(ids: string | string[]): Promise<void>;
  /**
   * Run a query within an explicit ACL scope. Results must include only
   * documents whose `spaceId` is in `scope.spaceIds` — the index is shared
   * across plugins, so this is the seam that keeps one caller from seeing
   * another's items.
   */
  query(query: SearchQuery, scope: SearchScope): Promise<Page<SearchHit>>;
}

/**
 * A unit fed into the index. The `id` is the stable item identity (the same id
 * the metadata store uses), so `upsert`/`delete` line up with item lifecycle.
 */
export interface SearchDoc {
  /** Stable item id — the upsert/delete key. */
  id: string;
  /** The space this item lives in. The ACL scope key; required, never blank. */
  spaceId: string;
  /** Primary indexed text — a heading, filename, or title. */
  title: string;
  /** Full-text body, if any (extracted file text, document contents). */
  text?: string;
  /** Item kind for filtering: "file" | "folder" | a content kind. */
  kind?: string;
  /** Originating storage path, when the item is file-backed. */
  path?: string;
  /** Connector instance that produced it, e.g. "r2-family". */
  connectorId?: string;
  /** ISO 8601 last-modified, for recency ranking / display. */
  modifiedAt?: string;
  /**
   * Arbitrary filterable fields, mirroring `files.metadata`. Adapters may index
   * a subset for `SearchQuery.filter`; the rest is opaque passthrough.
   */
  metadata?: Record<string, unknown>;
}

/**
 * What a caller expresses. Note what's absent: no space ids. The readable-space
 * boundary is supplied out-of-band by the host as a `SearchScope`, so a
 * sandboxed plugin cannot forge access to spaces it can't read.
 */
export interface SearchQuery {
  /** The user's query text. */
  text: string;
  /** Restrict to these kinds, e.g. ["file"] or ["invoice"]. */
  kinds?: string[];
  /** Equality filters over indexed `SearchDoc.metadata` fields. */
  filter?: Record<string, unknown>;
  /** Max hits to return. */
  limit?: number;
  /** Opaque pagination cursor from a prior `Page`. */
  cursor?: string;
}

/**
 * The ACL boundary the host attaches to every query. Resolved from the caller's
 * principal against the spaces model — never accepted from plugin code.
 */
export interface SearchScope {
  /** The spaces the caller may read. An empty list matches nothing. */
  spaceIds: string[];
}

/** One ranked match. Carries enough to render a result without a second fetch. */
export interface SearchHit {
  /** The matched item id (`SearchDoc.id`). */
  id: string;
  /** The space it belongs to (always within the query's `SearchScope`). */
  spaceId: string;
  /** Backend-relative relevance score; higher is better. Not comparable across backends. */
  score: number;
  title: string;
  /** A highlighted excerpt around the match, when the backend can produce one. */
  snippet?: string;
  kind?: string;
  path?: string;
  modifiedAt?: string;
}
