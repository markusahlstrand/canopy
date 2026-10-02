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
      -- ON DELETE CASCADE states the intent — text is not a record of anything once
      -- the file it describes is gone — but it does NOT currently enforce it, and
      -- saying so here is the point. SQLite leaves foreign keys off unless
      -- \`PRAGMA foreign_keys = ON\`, and the adapters set only
      -- \`defer_foreign_keys\` (ordering inside a transaction, not enforcement), so
      -- no cascade fires. It costs nothing and it is what a future enforcement
      -- switch would honour.
      --
      -- Nothing relies on it today because the drive has NO hard-delete path: a
      -- file is retired with \`deleted_at\`, and \`drive/search\` filters those out
      -- when it hydrates. Whoever adds one must delete the text row in the same
      -- operation rather than trusting this line — an orphan row would keep
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
  {
    version: '0003',
    sql: `
      -- Trash (#74). \`state\` is the FACT a read filters on; \`deleted_at\` is when it
      -- happened. Two columns for one event, and the split is deliberate: a
      -- kernel-composed page (K-41) filters by equality only, so "not trashed" has to
      -- be a value a caller can equal — \`deleted_at IS NULL\` is not expressible there,
      -- and rewriting the drive's hot listing as hand-composed SQL to get it would cost
      -- the declared sort vocabulary and the index the kernel builds behind it.
      --
      -- The invariant is therefore ours to hold, and only two operations write either
      -- column: state = 'trashed' if and only if deleted_at IS NOT NULL.
      ALTER TABLE drive_files ADD COLUMN state TEXT NOT NULL DEFAULT 'live';

      -- Existing rows are live by the default above; this makes any row that was
      -- already retired agree with it rather than sitting in a state no read expects.
      UPDATE drive_files SET state = 'trashed' WHERE deleted_at IS NOT NULL;
    `,
  },
  {
    version: '0004',
    sql: `
      -- Who is in this space (#79), as a name a person can recognise.
      --
      -- The kernel knows principals; a principal is a ULID. Sharing a folder means
      -- picking a PERSON, so something has to hold the difference between
      -- \`01JBQ…\` and "bjorn@example.com" — and nothing in the platform does: the
      -- identity directory maps a subject to a principal and stores no display
      -- identity, and the invite row that carried an email stops existing the moment
      -- it is accepted. So this is where an email goes to survive acceptance.
      --
      -- A PROJECTION, not a source of truth. Membership is the kernel's (a role at
      -- this node); this table only remembers what to call someone. A row here grants
      -- nothing, and a person missing from it is still a member — they are just
      -- someone this install has not seen sign in yet.
      --
      -- It is NOT wrong in the other direction: \`drive/forget-person\` deletes the row when
      -- somebody is removed from the space, along with every folder grant they held. That
      -- obligation was written here before anything could discharge it; this is the note
      -- saying it now is.
      --
      -- Written only by \`drive/record-person\`, which declares no HTTP route: the
      -- verified subject exists only in the worker, so the worker is the only caller
      -- that can assert who somebody is. Over a public route, a member could write
      -- another member's name and email onto their own row.
      CREATE TABLE drive_people (
        -- The principal this display identity belongs to. One row per person.
        principal TEXT PRIMARY KEY,
        -- Both nullable: an issuer need not release either claim, and a person with
        -- no name is shown by their email, or failing that not at all.
        email TEXT,
        name TEXT,
        -- When this install last saw them. Not a session record — a single timestamp
        -- that answers "is this a live member or someone from the first week".
        seen_at TEXT NOT NULL
      );

      -- The picker's order: people with a name or an address first, then by name.
      CREATE INDEX drive_people_by_name ON drive_people (name, email);

      -- Who a folder is shared with (#79), because the kernel cannot be asked.
      --
      -- \`ctx.grant\` enforces a share and there is NO read that enumerates grants —
      -- the platform's own console says so ("no enumeration; this view would be the
      -- only witness to grants it cannot read"). A share dialog has to show who has
      -- access, so the drive records the shares it made.
      --
      -- Enforcement is still the kernel's, and that ordering matters when the two
      -- disagree: a row here that the kernel does not back grants nothing, which is
      -- the safe direction. Both are written in one operation, so they part company
      -- only if a grant is made or withdrawn by some other path — a platform actor at
      -- the admin seam, say — and then this table is stale rather than dangerous.
      CREATE TABLE drive_folder_shares (
        folder_id TEXT NOT NULL,
        principal TEXT NOT NULL,
        -- The permission key granted, so withdrawing removes exactly what was given.
        permission TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        -- Who did the sharing. Kept because "who let them in" is the first question
        -- asked when somebody is somewhere they should not be.
        granted_by TEXT NOT NULL,
        PRIMARY KEY (folder_id, principal, permission)
      );

      -- The two reads: everyone on one folder, and every folder one person holds.
      CREATE INDEX drive_folder_shares_by_principal ON drive_folder_shares (principal, folder_id);
    `,
  },
  {
    version: '0005',
    sql: `ALTER TABLE drive_file_text ADD COLUMN extractor_revision TEXT NOT NULL DEFAULT 'pdf-v1';`,
  },
  { version: '0006', sql: 'ALTER TABLE drive_file_versions ADD COLUMN keep INTEGER NOT NULL DEFAULT 0 CHECK (keep IN (0, 1));' },
  {
    version: '0007',
    sql: `CREATE TABLE drive_file_details (
      id TEXT PRIMARY KEY NOT NULL,
      file_id TEXT NOT NULL UNIQUE REFERENCES drive_files(id),
      description TEXT NOT NULL DEFAULT '',
      labels_json TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );`,
  },
  {
    version: '0008',
    sql: `CREATE TABLE drive_file_comments (
      id TEXT PRIMARY KEY NOT NULL,
      file_id TEXT NOT NULL REFERENCES drive_files(id),
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE INDEX drive_file_comments_by_file ON drive_file_comments (file_id, id);`,
  },
];
