/**
 * The scope-local schema, hand-written for this slice.
 *
 * Substrat generates these from the model (`model-emit` → `migrations.generated.ts`,
 * with a journal and a `--check` gate against drift). That pipeline lives in the
 * platform repo and is worth adopting before this grows; until then the rule is
 * that these tables must match `spec/model.ts` exactly, because the kernel derives
 * its list indexes and its FTS triggers from the declaration, not from the DDL.
 *
 * Nothing here carries a space id. That absence is the conversion: in
 * `@canopy/store` every one of these tables has `tenant_id` as its first column
 * and every query filters on it. Here the scope is the space, so the column has
 * nothing to say.
 */
import type { SqlMigration } from '@substrat-run/kernel';

/** The root folder's id. Deterministic so a fresh scope has somewhere to write. */
export const ROOT_FOLDER_ID = 'root';

export const driveMigrations: SqlMigration[] = [
  {
    version: '0001',
    sql: `
      CREATE TABLE drive_folders (
        id TEXT PRIMARY KEY NOT NULL,
        parent_id TEXT NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        UNIQUE (path)
      );

      CREATE TABLE drive_files (
        id TEXT PRIMARY KEY NOT NULL,
        folder_id TEXT NOT NULL REFERENCES drive_folders(id),
        name TEXT NOT NULL,
        current_version_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        UNIQUE (folder_id, name)
      );

      CREATE TABLE drive_file_versions (
        id TEXT PRIMARY KEY NOT NULL,
        file_id TEXT NOT NULL REFERENCES drive_files(id),
        source TEXT NOT NULL,
        blob_ref TEXT,
        external_key TEXT,
        etag TEXT,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      );

      CREATE INDEX drive_file_versions_by_file ON drive_file_versions (file_id, id);

      -- Every scope has a root, created with the schema rather than by a first
      -- write: a folder is what a grant narrows onto, so the top of the tree has
      -- to exist before anyone can be given anything.
      INSERT INTO drive_folders (id, parent_id, path, name, created_at, created_by)
      VALUES ('${ROOT_FOLDER_ID}', '${ROOT_FOLDER_ID}', '', '', '1970-01-01T00:00:00.000Z', 'system');
    `,
  },
];
