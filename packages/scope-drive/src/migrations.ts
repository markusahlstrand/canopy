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
        -- The declared \`parents: ['folder']\` edge, as a constraint. Self-referencing,
        -- which the root row uses: SQLite checks a foreign key after the row lands, so
        -- a row that is its own parent inserts cleanly. Without it an orphan parent id
        -- is a permission walk that ends nowhere, discovered at check time.
        parent_id TEXT NOT NULL REFERENCES drive_folders(id),
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
  {
    version: '0002',
    sql: `
      -- A file's extracted text, and the state of having tried (S9b, #56).
      --
      -- Separate from drive_files because the text is unbounded and the file row is
      -- the hot read, and because the kernel's FTS triggers are generated over a
      -- table's columns — what is indexed is this table, off the path of an
      -- ordinary listing.
      --
      -- ON DELETE CASCADE, unlike the other edges here: text is not a record of
      -- anything once the file it describes is gone, and an orphan row would keep
      -- answering searches for a document nobody can open.
      CREATE TABLE drive_file_text (
        id TEXT PRIMARY KEY NOT NULL,
        -- UNIQUE, not just indexed: one row per file is the model, and enforcing it
        -- here is what makes the upsert in \`drive/record-text\` a fact rather than a
        -- convention two code paths have to agree on.
        file_id TEXT NOT NULL UNIQUE REFERENCES drive_files(id) ON DELETE CASCADE,
        version_id TEXT NOT NULL,
        status TEXT NOT NULL,
        -- Empty for every status but 'indexed'. NOT NULL so the FTS trigger always
        -- has a string to index rather than a NULL to special-case.
        text TEXT NOT NULL DEFAULT '',
        chars INTEGER NOT NULL DEFAULT 0,
        extracted_at TEXT NOT NULL,
        detail TEXT
      );

      -- The sweep a backfill needs: "which files have no text row, or a stale one".
      CREATE INDEX drive_file_text_by_status ON drive_file_text (status, file_id);
    `,
  },
];
