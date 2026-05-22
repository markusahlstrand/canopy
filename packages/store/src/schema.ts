import type { Db } from "./db";

/**
 * Numbered, forward-only migrations tracked in `_migrations` (portable across
 * D1 and libsql — no reliance on PRAGMA user_version). Each migration runs as
 * one atomic batch.
 *
 * A file's content is **polymorphic**: a version is either `blob` (Canopy owns
 * the bytes — content-addressed, dedup'd, refcounted) or `external` (a pointer
 * into a connected filesystem/S3/R2 that the user owns — indexed by key+etag,
 * not refcounted). The DB is the source of truth for blobs; for external files
 * it's an index over the connector.
 */
export const MIGRATIONS: { version: number; statements: string[] }[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS blobs (
         hash       TEXT PRIMARY KEY,
         size       INTEGER NOT NULL,
         ref_count  INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS files (
         id                 TEXT PRIMARY KEY,
         tenant_id          TEXT NOT NULL,
         owner_id           TEXT NOT NULL,
         name               TEXT NOT NULL,
         current_version_id TEXT,
         metadata           TEXT NOT NULL DEFAULT '{}',
         created_at         TEXT NOT NULL,
         updated_at         TEXT NOT NULL,
         deleted_at         TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_files_tenant ON files (tenant_id, owner_id, deleted_at)`,
      `CREATE INDEX IF NOT EXISTS idx_files_path ON files (tenant_id, owner_id, json_extract(metadata, '$.path'))`,
      `CREATE TABLE IF NOT EXISTS file_versions (
         id           TEXT PRIMARY KEY,
         file_id      TEXT NOT NULL REFERENCES files(id),
         source       TEXT NOT NULL DEFAULT 'blob',   -- 'blob' | 'external'
         blob_hash    TEXT REFERENCES blobs(hash),    -- source='blob' only
         connector_id TEXT,                           -- source='external' only
         external_key TEXT,                           -- source='external' only
         etag         TEXT,                           -- source='external' only
         mime         TEXT,
         size         INTEGER NOT NULL DEFAULT 0,
         created_at   TEXT NOT NULL,
         created_by   TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_versions_file ON file_versions (file_id)`,
      `CREATE INDEX IF NOT EXISTS idx_versions_external ON file_versions (connector_id, external_key)`,
      `CREATE TABLE IF NOT EXISTS file_permissions (
         file_id   TEXT NOT NULL REFERENCES files(id),
         principal TEXT NOT NULL,
         role      TEXT NOT NULL,
         PRIMARY KEY (file_id, principal)
       )`,
      // A connected backend (filesystem / S3 / R2) the user owns; its objects are indexed.
      `CREATE TABLE IF NOT EXISTS connections (
         id         TEXT PRIMARY KEY,
         tenant_id  TEXT NOT NULL,
         owner_id   TEXT NOT NULL,
         type       TEXT NOT NULL,                    -- 's3' | 'r2' | 'local' | …
         name       TEXT NOT NULL,
         config     TEXT NOT NULL DEFAULT '{}',       -- JSON (secrets by reference, not inline)
         created_at TEXT NOT NULL
       )`,
      // One crawl/index of a connection — resumable via cursor.
      `CREATE TABLE IF NOT EXISTS index_runs (
         id            TEXT PRIMARY KEY,
         connection_id TEXT NOT NULL REFERENCES connections(id),
         status        TEXT NOT NULL,                 -- 'queued' | 'running' | 'done' | 'error'
         cursor        TEXT,
         files_seen    INTEGER NOT NULL DEFAULT 0,
         started_at    TEXT NOT NULL,
         finished_at   TEXT,
         error         TEXT
       )`,
    ],
  },
];

/** Apply any migrations newer than what's recorded. Safe to call on every boot. */
export async function runMigrations(db: Db): Promise<void> {
  await db.run("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = await db.first<{ v: number | null }>("SELECT MAX(version) AS v FROM _migrations");
  const current = row?.v ?? 0;
  const now = new Date().toISOString();
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    await db.batch([
      ...m.statements.map((sql) => ({ sql })),
      { sql: "INSERT INTO _migrations (version, applied_at) VALUES (?, ?)", params: [m.version, now] },
    ]);
  }
}
