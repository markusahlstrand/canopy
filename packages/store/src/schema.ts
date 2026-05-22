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
  {
    // Sharing — relation-tuple (Zanzibar-lite) access control. A `files.tenant_id`
    // value is now a *space id*. Access derives from tuples + a recursive check,
    // so `file_permissions` is superseded (left in place, unused).
    version: 2,
    statements: [
      // User directory — upserted on login so files can be shared by email.
      `CREATE TABLE IF NOT EXISTS users (
         sub        TEXT PRIMARY KEY,
         email      TEXT,
         name       TEXT,
         picture    TEXT,
         updated_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_users_email ON users (email)`,
      // A space (drive): "personal" (one per user) or "group" (e.g. a family).
      `CREATE TABLE IF NOT EXISTS spaces (
         id         TEXT PRIMARY KEY,
         name       TEXT NOT NULL,
         kind       TEXT NOT NULL,                 -- 'personal' | 'group'
         created_by TEXT NOT NULL,
         created_at TEXT NOT NULL
       )`,
      // Relation tuples: object#relation@subject, subject optionally a userset
      // (subject_relation, e.g. space:fam#member). '' = a direct subject.
      `CREATE TABLE IF NOT EXISTS relation_tuples (
         object_type      TEXT NOT NULL,           -- 'file' | 'space'
         object_id        TEXT NOT NULL,
         relation         TEXT NOT NULL,           -- 'owner' | 'editor' | 'viewer' | 'space'
         subject_type     TEXT NOT NULL,           -- 'user' | 'space' | 'email'
         subject_id       TEXT NOT NULL,
         subject_relation TEXT NOT NULL DEFAULT '',-- '' | 'member'
         PRIMARY KEY (object_type, object_id, relation, subject_type, subject_id, subject_relation)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_tuples_subject ON relation_tuples (subject_type, subject_id)`,
      `CREATE INDEX IF NOT EXISTS idx_tuples_object ON relation_tuples (object_type, object_id, relation)`,
    ],
  },
  {
    // Per-user, per-space presentation preference: a "mounted" group space shows
    // inline in My Drive (the merged/family feel); unmounted lives in the
    // switcher only. No row = mounted by default. (Personal space is always shown.)
    version: 3,
    statements: [
      `CREATE TABLE IF NOT EXISTS space_prefs (
         user_sub TEXT NOT NULL,
         space_id TEXT NOT NULL,
         mounted  INTEGER NOT NULL DEFAULT 1,
         PRIMARY KEY (user_sub, space_id)
       )`,
    ],
  },
  {
    // Explicit (empty) folders. Folders are otherwise virtual — derived from
    // files' metadata.path — so this lets an empty folder exist before any file
    // is put in it. `path` is the full virtual path, e.g. "Documents/2026".
    version: 4,
    statements: [
      `CREATE TABLE IF NOT EXISTS folders (
         space_id   TEXT NOT NULL,
         path       TEXT NOT NULL,
         created_at TEXT NOT NULL,
         PRIMARY KEY (space_id, path)
       )`,
    ],
  },
  {
    // App passwords — per-device tokens for Basic-auth clients (e.g. WebDAV in
    // Finder) that can't do OIDC. Only the hash is stored; the token is shown once.
    version: 5,
    statements: [
      `CREATE TABLE IF NOT EXISTS app_passwords (
         id           TEXT PRIMARY KEY,
         user_sub     TEXT NOT NULL,
         name         TEXT NOT NULL,
         token_hash   TEXT NOT NULL,
         created_at   TEXT NOT NULL,
         last_used_at TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_app_passwords_user ON app_passwords (user_sub)`,
      `CREATE INDEX IF NOT EXISTS idx_app_passwords_hash ON app_passwords (token_hash)`,
    ],
  },
  {
    // KV cache — short-TTL JSON blobs for external API responses (e.g. GitHub
    // issues/releases) so plugin data endpoints stay well under rate limits.
    version: 6,
    statements: [
      `CREATE TABLE IF NOT EXISTS kv_cache (
         k          TEXT PRIMARY KEY,
         v          TEXT NOT NULL,
         expires_at INTEGER NOT NULL
       )`,
    ],
  },
  {
    // Single-use invite links to a space. Unlike a share-by-email grant (which
    // pre-binds an address), the token is opaque and not bound to anyone — whoever
    // signs in and accepts joins at `role`. Consumed on first accept (accepted_by
    // set) or once expires_at passes; the token lives in the URL.
    version: 7,
    statements: [
      `CREATE TABLE IF NOT EXISTS space_invites (
         token       TEXT PRIMARY KEY,
         space_id    TEXT NOT NULL,
         role        TEXT NOT NULL,                 -- 'owner' | 'editor' | 'viewer'
         created_by  TEXT NOT NULL,
         created_at  TEXT NOT NULL,
         expires_at  TEXT,                          -- null = never expires
         accepted_by TEXT,                          -- null = unused (single-use)
         accepted_at TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_space_invites_space ON space_invites (space_id)`,
    ],
  },
  {
    // Per-user, per-plugin settings (e.g. the GitHub source's repo + token). The
    // `config` JSON is opaque to the store; the API encrypts any secret fields
    // (the token) before persisting and decrypts them on read.
    version: 8,
    statements: [
      `CREATE TABLE IF NOT EXISTS plugin_settings (
         user_sub   TEXT NOT NULL,
         plugin_id  TEXT NOT NULL,
         config     TEXT NOT NULL DEFAULT '{}',
         updated_at TEXT NOT NULL,
         PRIMARY KEY (user_sub, plugin_id)
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
