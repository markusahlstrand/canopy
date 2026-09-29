/**
 * The drive's handlers — the first canopy operations written as scope-local code.
 *
 * Read one of these against its `@canopy/store` counterpart and the conversion is
 * visible in one line: `FileService.list(tenantId, path)` opens with a space id and
 * carries it into every query; `drive/list-folder` has no space id to carry. The
 * caller made one hop to the scope, and everything after it is local.
 *
 * Three rules hold here, and they are the ones that make the move worth making:
 *
 * 1. **`ctx.sql` only.** No connection, no adapter, no `Db` handle — so the same
 *    handler runs on SQLite in a test and in a Durable Object in production.
 * 2. **The kernel decides who may do this — when the handler asks it.** The
 *    `permission` on an operation's declaration feeds the registry, the routes and
 *    the generated document; it does NOT gate `invoke`. Every handler below opens
 *    with `assertAllowed(await ctx.check(...))`, and one that forgets is a handler
 *    with no authorization at all. A handler never reads a grant table.
 * 3. **Facts leave as events**, not as writes into someone else's table.
 */
import {
  operationInputsOf,
  substratError,
  type HandlerInput,
  type HandlerOutput,
  type Page,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';
import { DRIVE_PERM } from './manifest.js';
import { driveOperations } from '../spec/model.js';
import { driveManifest } from './manifest.js';
import { driveMigrations, ROOT_FOLDER_ID } from './migrations.js';

interface FolderRow {
  id: string;
  parent_id: string;
  path: string;
  name: string;
  created_at: string;
  created_by: string;
}

interface FileRow {
  id: string;
  folder_id: string;
  name: string;
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
  /** `'live'` or `'trashed'` — what the reads filter on. */
  state: string;
  deleted_at: string | null;
}

interface VersionRow {
  id: string;
  file_id: string;
  source: string;
  blob_ref: string | null;
  external_key: string | null;
  etag: string | null;
  mime: string;
  size: number;
  created_at: string;
  created_by: string;
}

interface FileTextRow {
  id: string;
  file_id: string;
  version_id: string;
  status: string;
  text: string;
  chars: number;
  extracted_at: string;
  detail: string | null;
}

/**
 * The file row, or a refusal — and a TRASHED file is a refusal.
 *
 * `not_found` rather than a state-specific error on purpose: to a caller, a file in the
 * trash is gone, and an error distinguishing "trashed" from "never existed" hands back
 * the existence of something they were not shown. The trash listing is the one door
 * that says otherwise, and `restore-file` is the one write that reaches through it.
 */
function liveFile(ctx: OperationContext, fileId: string): FileRow {
  const file = ctx.sql.query<FileRow>('SELECT * FROM drive_files WHERE id = ?', [fileId])[0];
  if (!file || file.state !== 'live') throw substratError('not_found', `file not found: ${fileId}`);
  return file;
}

/** The entity refs the checks narrow onto. */
const folderRef = (id: string) => ({ entityType: 'folder', entityId: id }) as const;
const fileRef = (id: string) => ({ entityType: 'file', entityId: id }) as const;
const versionRef = (id: string) => ({ entityType: 'file_version', entityId: id }) as const;
const fileTextRef = (id: string) => ({ entityType: 'file_text', entityId: id }) as const;

const operations = {
  'drive/list-folder': async (ctx, input) => {
    // The declaration names the permission; the handler still asks the checker.
    // That split is the conversion of `authz.ts`: canopy's `pathRole(space, path)`
    // walked ancestors itself, and this walks the declared parent edge instead —
    // one call, and the answer carries its own `explain`.
    assertAllowed(await ctx.check(DRIVE_PERM.read, folderRef(input.folderId)));
    // The kernel composes the walk from `paged.over` — the sort vocabulary, the
    // keyset comparison and the index behind them are one declared thing. What is
    // left to the handler is the filter that says which folder.
    // `state: 'live'` is what keeps trashed files out of the drive's hot listing. It
    // rides as a declared equality filter rather than a hand-written `IS NULL`,
    // because that is the only shape a kernel-composed page can express (K-41).
    return ctx.page<FileRow>('file', {
      ...input,
      filters: { folder_id: input.folderId, state: 'live' },
    }) as Page<FileRow>;
  },

  'drive/create-folder': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.write, folderRef(input.parentId)));
    const parent = ctx.sql.query<FolderRow>('SELECT * FROM drive_folders WHERE id = ?', [
      input.parentId,
    ])[0];
    if (!parent) throw substratError('not_found', `folder not found: ${input.parentId}`);

    // A path is the parent's path plus the name. It stays a derived column rather
    // than the identity: canopy addressed a file BY path, which made a rename a
    // rewrite of every descendant. Here the edge is the parent id and the path is
    // what the UI reads.
    const path = parent.path === '' ? input.name : `${parent.path}/${input.name}`;
    if (ctx.sql.query<FolderRow>('SELECT id FROM drive_folders WHERE path = ?', [path])[0]) {
      throw substratError('conflict', `a folder already exists at ${path}`);
    }

    const row: FolderRow = {
      id: ulid(),
      parent_id: parent.id,
      path,
      name: input.name,
      created_at: ctx.now(),
      created_by: ctx.principal,
    };
    ctx.sql.exec(
      'INSERT INTO drive_folders (id, parent_id, path, name, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [row.id, row.parent_id, row.path, row.name, row.created_at, row.created_by],
    );
    // The edge the permission walk follows. Declaring `parents` in the model says
    // the edge MAY exist; `ctx.link` is what makes this folder's actual parent a
    // fact the checker can walk. Without it a grant on the root reaches nothing
    // below it — which is precisely how canopy's `pathRole` walk gets replaced:
    // the ancestor chain stops being recomputed from a path string on every read.
    ctx.link(folderRef(row.id), folderRef(parent.id));
    ctx.emit({
      type: 'drive.folder-created',
      schemaVersion: 1,
      entity: { entityType: 'folder', entityId: row.id },
      piiClass: 'none',
      payload: { id: row.id, parent_id: row.parent_id, path: row.path },
    });
    return row;
  },

  'drive/ensure-file': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.write, folderRef(input.folderId)));
    if (!ctx.sql.query<FolderRow>('SELECT id FROM drive_folders WHERE id = ?', [input.folderId])[0]) {
      throw substratError('not_found', `folder not found: ${input.folderId}`);
    }

    // Create-or-return, keyed by (folder, name) — the same identity the UNIQUE index
    // has, so writing the same name twice is a new VERSION of one file rather than a
    // second file. Idempotent, because the upload that follows it may be retried.
    const existing = ctx.sql.query<FileRow>(
      'SELECT * FROM drive_files WHERE folder_id = ? AND name = ?',
      [input.folderId, input.name],
    )[0];
    // A trashed row still holds the name — the UNIQUE index does not care about state
    // — so writing over it would either resurrect it silently or fail on the insert.
    // Say which it is instead: the name is taken by something in the trash, and the
    // caller can restore it or pick another name.
    if (existing?.state === 'trashed') {
      throw substratError(
        'conflict',
        `a trashed file holds the name '${input.name}' — restore it or choose another name`,
      );
    }
    if (existing) return existing;

    const now = ctx.now();
    const row: FileRow = {
      id: ulid(),
      folder_id: input.folderId,
      name: input.name,
      current_version_id: null,
      created_at: now,
      updated_at: now,
      state: 'live',
      deleted_at: null,
    };
    ctx.sql.exec(
      'INSERT INTO drive_files (id, folder_id, name, current_version_id, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      [row.id, row.folder_id, row.name, null, row.created_at, row.updated_at],
    );
    ctx.link(fileRef(row.id), folderRef(row.folder_id));
    ctx.emit({
      type: 'drive.file-created',
      schemaVersion: 1,
      entity: { entityType: 'file', entityId: row.id },
      piiClass: 'none',
      payload: { id: row.id, folder_id: row.folder_id },
    });
    return row;
  },

  'drive/record-version': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.write, fileRef(input.fileId)));
    const file = ctx.sql.query<FileRow>('SELECT * FROM drive_files WHERE id = ?', [input.fileId])[0];
    if (!file) throw substratError('not_found', `file not found: ${input.fileId}`);
    // Writing to something in the trash is refused rather than silently resurrecting
    // it. This update used to clear `deleted_at` — harmless before trash existed, and
    // afterwards a way to leave `state = 'trashed'` with no timestamp beside it, which
    // is a row no read expects.
    if (file.state !== 'live') {
      throw substratError('conflict', `this file is in the trash — restore it before writing to it`);
    }

    // One location, guaranteed by the declaration's discriminated union: the columns
    // the other source would use stay null because there is nothing to read them
    // from, not because a check remembered to blank them.
    const loc = input.location;

    /**
     * A blob version is verified against the attachment, never taken on the caller's
     * word. This operation carries a URL, so "the worker route always passes what it
     * just uploaded" is not a property of the system — it is a property of one caller.
     *
     * Two things are checked here and they fail differently on purpose: an id naming
     * no attachment is `not_found`, and an id naming an attachment on ANOTHER file is
     * refused outright. Without the second, a writer could point their file at someone
     * else's bytes; the attachment surface would still gate the read by the owning
     * entity, so nothing leaks, but the version chain would be a record of something
     * that never happened.
     *
     * `size` and `mime` then come from the row rather than the request — a version
     * cannot describe the bytes as something they are not.
     */
    let mime: string;
    let size: number;
    if (loc.source === 'blob') {
      const attachment = ctx.sql.query<{ entity_id: string; content_type: string; size: number }>(
        `SELECT entity_id, content_type, size FROM _substrat_attachments
         WHERE id = ? AND entity_type = 'file'`,
        [loc.blobRef],
      )[0];
      if (!attachment) throw substratError('not_found', `no attachment: ${loc.blobRef}`);
      if (attachment.entity_id !== file.id) {
        throw substratError(
          'validation_failed',
          `attachment ${loc.blobRef} belongs to another file — a version names bytes uploaded against its own file`,
        );
      }
      mime = attachment.content_type;
      size = attachment.size;
    } else {
      mime = loc.mime;
      size = loc.size;
    }

    const now = ctx.now();
    const version: VersionRow = {
      id: ulid(),
      file_id: file.id,
      source: loc.source,
      blob_ref: loc.source === 'blob' ? loc.blobRef : null,
      external_key: loc.source === 'external' ? loc.externalKey : null,
      etag: loc.source === 'external' ? (loc.etag ?? null) : null,
      mime,
      size,
      created_at: now,
      created_by: ctx.principal,
    };
    ctx.sql.exec(
      'INSERT INTO drive_file_versions (id, file_id, source, blob_ref, external_key, etag, mime, size, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        version.id,
        version.file_id,
        version.source,
        version.blob_ref,
        version.external_key,
        version.etag,
        version.mime,
        version.size,
        version.created_at,
        version.created_by,
      ],
    );
    ctx.link(versionRef(version.id), fileRef(file.id));
    ctx.sql.exec(
      'UPDATE drive_files SET current_version_id = ?, updated_at = ? WHERE id = ?',
      [version.id, now, file.id],
    );

    const written: FileRow = { ...file, current_version_id: version.id, updated_at: now };
    ctx.emit({
      type: 'drive.file-written',
      schemaVersion: 1,
      entity: { entityType: 'file', entityId: written.id },
      piiClass: 'none',
      payload: { id: written.id, folder_id: written.folder_id, current_version_id: version.id },
    });
    return written;
  },

  'drive/get-file': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read, fileRef(input.fileId)));
    const file = liveFile(ctx, input.fileId);
    const version = file.current_version_id
      ? (ctx.sql.query<VersionRow>('SELECT * FROM drive_file_versions WHERE id = ?', [
          file.current_version_id,
        ])[0] ?? null)
      : null;
    return { file, version };
  },

  'drive/rename-file': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.write, fileRef(input.fileId)));
    // Through `liveFile`, so renaming something in the trash is `not_found` like every
    // other read of it. `restore-file` stays the only write that reaches through.
    const file = liveFile(ctx, input.fileId);
    if (file.name === input.name) return file;

    const taken = ctx.sql.query<{ id: string }>(
      'SELECT id FROM drive_files WHERE folder_id = ? AND name = ? AND id != ?',
      [file.folder_id, input.name, file.id],
    )[0];
    if (taken) throw substratError('conflict', `this folder already has a '${input.name}'`);

    const now = ctx.now();
    ctx.sql.exec('UPDATE drive_files SET name = ?, updated_at = ? WHERE id = ?', [
      input.name,
      now,
      file.id,
    ]);
    const renamed: FileRow = { ...file, name: input.name, updated_at: now };
    ctx.emit({
      type: 'drive.file-renamed',
      schemaVersion: 1,
      entity: { entityType: 'file', entityId: renamed.id },
      piiClass: 'none',
      payload: { id: renamed.id, folder_id: renamed.folder_id, name: renamed.name },
    });
    return renamed;
  },

  'drive/rename-folder': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.write, folderRef(input.folderId)));
    const folder = ctx.sql.query<FolderRow>('SELECT * FROM drive_folders WHERE id = ?', [
      input.folderId,
    ])[0];
    if (!folder) throw substratError('not_found', `folder not found: ${input.folderId}`);
    if (folder.id === ROOT_FOLDER_ID) {
      throw substratError('validation_failed', 'the root folder has no name to change');
    }
    if (folder.name === input.name) return folder;

    const parent = ctx.sql.query<FolderRow>('SELECT * FROM drive_folders WHERE id = ?', [
      folder.parent_id,
    ])[0];
    const path = parent && parent.path !== '' ? `${parent.path}/${input.name}` : input.name;
    if (ctx.sql.query<{ id: string }>('SELECT id FROM drive_folders WHERE path = ? AND id != ?', [
      path,
      folder.id,
    ])[0]) {
      throw substratError('conflict', `a folder already exists at ${path}`);
    }

    /**
     * The descendants' paths, and NOTHING else.
     *
     * `path` is derived, so it is the only thing a rename may touch: no `parent_id`
     * moves, no grant is rewritten, no file row is read. That is the difference the
     * model change bought — canopy addressed files BY path, so this operation there
     * had to rewrite every descendant's identity and every grant that named one.
     *
     * The prefix guard compares a literal substring rather than using `LIKE`. Two
     * traps, one after the other: `LIKE old || '%'` would catch a sibling called
     * `Documents 2026`, and `LIKE` ALSO reads `%` and `_` inside the old path as
     * wildcards — a folder named `Notes_1` would match `NotesA1/child` and rewrite a
     * stranger's path. `segment` permits both characters, so the guard cannot rely on
     * them being absent.
     */
    const prefix = `${folder.path}/`;
    ctx.sql.exec(
      `UPDATE drive_folders
          SET path = ? || substr(path, ?)
        WHERE path = ? OR substr(path, 1, ?) = ?`,
      [path, folder.path.length + 1, folder.path, prefix.length, prefix],
    );
    ctx.sql.exec('UPDATE drive_folders SET name = ? WHERE id = ?', [input.name, folder.id]);

    const renamed: FolderRow = { ...folder, name: input.name, path };
    ctx.emit({
      type: 'drive.folder-renamed',
      schemaVersion: 1,
      entity: { entityType: 'folder', entityId: renamed.id },
      piiClass: 'none',
      payload: { id: renamed.id, path: renamed.path },
    });
    return renamed;
  },

  'drive/move-file': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.write, folderRef(input.folderId)));
    const file = liveFile(ctx, input.fileId);
    // Moving something OUT of a folder is a write to that folder too, and the declaration
    // can only narrow onto one entity. The destination is the declared one because it is
    // the permission a caller is most likely to lack.
    assertAllowed(await ctx.check(DRIVE_PERM.write, folderRef(file.folder_id)));
    if (file.folder_id === input.folderId) return file;

    if (!ctx.sql.query<FolderRow>('SELECT id FROM drive_folders WHERE id = ?', [input.folderId])[0]) {
      throw substratError('not_found', `folder not found: ${input.folderId}`);
    }
    // Every state, not just live: `(folder_id, name)` is unique regardless, so a trashed
    // file in the destination still holds the name. Filtering to live rows passed this
    // check and then hit the UNIQUE constraint — a raw database error where the caller
    // should get a `conflict` saying which of the two cases it is. Same rule and same two
    // messages as `ensure-file`.
    const taken = ctx.sql.query<{ id: string; state: string }>(
      'SELECT id, state FROM drive_files WHERE folder_id = ? AND name = ?',
      [input.folderId, file.name],
    )[0];
    if (taken) {
      throw substratError(
        'conflict',
        taken.state === 'trashed'
          ? `a trashed file in that folder holds the name '${file.name}' — restore it or rename this one`
          : `that folder already has a '${file.name}'`,
      );
    }

    const now = ctx.now();
    ctx.sql.exec('UPDATE drive_files SET folder_id = ?, updated_at = ? WHERE id = ?', [
      input.folderId,
      now,
      file.id,
    ]);
    // The edge, atomically. This is what makes access follow: a grant above the old folder
    // stops reaching the file here, one above the new folder starts, and the kernel
    // tombstones the old edge and records `entity.relinked` on the file's timeline.
    ctx.relink(fileRef(file.id), folderRef(file.folder_id), folderRef(input.folderId));

    const moved: FileRow = { ...file, folder_id: input.folderId, updated_at: now };
    ctx.emit({
      type: 'drive.file-moved',
      schemaVersion: 1,
      entity: { entityType: 'file', entityId: moved.id },
      piiClass: 'none',
      payload: { id: moved.id, folder_id: moved.folder_id },
    });
    return moved;
  },

  'drive/move-folder': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.write, folderRef(input.parentId)));
    const folder = ctx.sql.query<FolderRow>('SELECT * FROM drive_folders WHERE id = ?', [
      input.folderId,
    ])[0];
    if (!folder) throw substratError('not_found', `folder not found: ${input.folderId}`);
    if (folder.id === ROOT_FOLDER_ID) {
      throw substratError('validation_failed', 'the root folder has nowhere to go');
    }
    assertAllowed(await ctx.check(DRIVE_PERM.write, folderRef(folder.parent_id)));
    if (folder.parent_id === input.parentId) return folder;

    const parent = ctx.sql.query<FolderRow>('SELECT * FROM drive_folders WHERE id = ?', [
      input.parentId,
    ])[0];
    if (!parent) throw substratError('not_found', `folder not found: ${input.parentId}`);

    /**
     * A folder cannot move inside itself.
     *
     * `relink` refuses this too — it knows the edge graph — but the refusal has to come
     * first, because the path rewrite below would already have built the cycle by the time
     * the kernel saw the edge. The check is on PATHS rather than a walk, which is the
     * cheaper question with the same answer: a descendant's path starts with this one's.
     */
    const prefix = `${folder.path}/`;
    if (parent.id === folder.id || parent.path === folder.path || parent.path.startsWith(prefix)) {
      throw substratError('validation_failed', 'a folder cannot move inside itself');
    }

    const path = parent.path === '' ? folder.name : `${parent.path}/${folder.name}`;
    if (
      ctx.sql.query<{ id: string }>('SELECT id FROM drive_folders WHERE path = ? AND id != ?', [
        path,
        folder.id,
      ])[0]
    ) {
      throw substratError('conflict', `a folder already exists at ${path}`);
    }

    // The subtree's paths, exactly as `rename-folder` re-derives them — literal prefix, so
    // `%` and `_` in the old path stay characters.
    ctx.sql.exec(
      `UPDATE drive_folders
          SET path = ? || substr(path, ?)
        WHERE path = ? OR substr(path, 1, ?) = ?`,
      [path, folder.path.length + 1, folder.path, prefix.length, prefix],
    );
    ctx.sql.exec('UPDATE drive_folders SET parent_id = ? WHERE id = ?', [parent.id, folder.id]);
    // One edge for the whole subtree: everything below reaches its grants through this
    // folder, so relinking it moves access for all of them at once.
    ctx.relink(folderRef(folder.id), folderRef(folder.parent_id), folderRef(parent.id));

    const moved: FolderRow = { ...folder, parent_id: parent.id, path };
    ctx.emit({
      type: 'drive.folder-moved',
      schemaVersion: 1,
      entity: { entityType: 'folder', entityId: moved.id },
      piiClass: 'none',
      payload: { id: moved.id, parent_id: moved.parent_id, path: moved.path },
    });
    return moved;
  },

  'drive/trash-file': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.write, fileRef(input.fileId)));
    const file = ctx.sql.query<FileRow>('SELECT * FROM drive_files WHERE id = ?', [input.fileId])[0];
    if (!file) throw substratError('not_found', `file not found: ${input.fileId}`);
    if (file.state === 'trashed') return file;

    // Both columns, in one statement: `state` is what reads filter on and
    // `deleted_at` is when it happened, and a row where they disagree is a row no
    // read expects. Nothing else writes either one.
    const now = ctx.now();
    ctx.sql.exec(
      "UPDATE drive_files SET state = 'trashed', deleted_at = ?, updated_at = ? WHERE id = ?",
      [now, now, file.id],
    );
    const trashed: FileRow = { ...file, state: 'trashed', deleted_at: now, updated_at: now };
    ctx.emit({
      type: 'drive.file-trashed',
      schemaVersion: 1,
      entity: { entityType: 'file', entityId: trashed.id },
      piiClass: 'none',
      payload: { id: trashed.id, folder_id: trashed.folder_id },
    });
    return trashed;
  },

  'drive/restore-file': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.write, fileRef(input.fileId)));
    const file = ctx.sql.query<FileRow>('SELECT * FROM drive_files WHERE id = ?', [input.fileId])[0];
    if (!file) throw substratError('not_found', `file not found: ${input.fileId}`);
    if (file.state === 'live') return file;

    /**
     * No uniqueness check here, and that is a consequence rather than an omission: a
     * trashed file KEEPS its name. `(folder_id, name)` is unique regardless of state,
     * so both ways in — `ensure-file` and `rename-file` — refuse a name the trash
     * holds, and nothing can have taken it while this sat there. A restore therefore
     * cannot conflict, and a check for it would be unreachable code with a test that
     * cannot be written.
     *
     * The alternative — freeing the name on trash, so a new file may reuse it — needs
     * the uniqueness to become partial (`WHERE state = 'live'`), which contradicts the
     * `key: ['folder_id', 'name']` the model declares. Worth doing if the product wants
     * it; it is a model change, not a branch here.
     */
    const now = ctx.now();
    ctx.sql.exec(
      "UPDATE drive_files SET state = 'live', deleted_at = NULL, updated_at = ? WHERE id = ?",
      [now, file.id],
    );
    const restored: FileRow = { ...file, state: 'live', deleted_at: null, updated_at: now };
    ctx.emit({
      type: 'drive.file-restored',
      schemaVersion: 1,
      entity: { entityType: 'file', entityId: restored.id },
      piiClass: 'none',
      payload: { id: restored.id, folder_id: restored.folder_id },
    });
    return restored;
  },

  'drive/list-trash': async (ctx, input) => {
    // Scope-wide, so there is no folder to check against up front: what a caller may
    // see is decided per row by the checker. Over-fetch, because the filter runs after
    // the walk and a page filtered afterwards returns fewer than it asked for.
    const limit = input.limit ?? 50;
    const scan = limit * 4;
    const rows = input.cursor
      ? ctx.sql.query<FileRow>(
          "SELECT * FROM drive_files WHERE state = 'trashed' AND id > ? ORDER BY id LIMIT ?",
          [input.cursor, scan],
        )
      : ctx.sql.query<FileRow>(
          "SELECT * FROM drive_files WHERE state = 'trashed' ORDER BY id LIMIT ?",
          [scan],
        );

    const visible: FileRow[] = [];
    let examined = 0;
    for (const row of rows) {
      if (visible.length === limit) break;
      examined += 1;
      if ((await ctx.check(DRIVE_PERM.read, fileRef(row.id))).allowed) visible.push(row);
    }

    /**
     * The cursor is the last row EXAMINED — readable or not — and it is handed back
     * whenever anything might remain. Two ways something can:
     *
     * - the loop stopped early because the page filled, leaving rows in this batch
     *   (`examined < rows.length`);
     * - the loop examined everything AND the batch was saturated, so the next rows are
     *   behind the `LIMIT` (`rows.length === scan`).
     *
     * Either alone is a walk that ends too early, and they do not imply each other:
     * three readable rows with `limit: 1` fills the page on row one while the batch is
     * not saturated, and four unreadable rows saturates the batch while the page never
     * fills. Both dropped rows before — the first because the cursor was absent, the
     * second because the walk stopped at the first dense patch of other people's files.
     */
    const last = examined > 0 ? rows[examined - 1] : undefined;
    const more = examined < rows.length || rows.length === scan;
    const next = last && more ? last.id : null;
    return { entries: visible, nextCursor: next } as unknown as HandlerOutput<
      (typeof driveOperations)['drive/list-trash']
    >;
  },

  'drive/file-versions': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read, fileRef(input.fileId)));
    liveFile(ctx, input.fileId);
    // Keyset over the ULID id, descending: a version id is creation-ordered, so
    // "newest first" needs no second column and no `created_at` tie-break.
    const limit = input.limit ?? 50;
    const rows = input.cursor
      ? ctx.sql.query<VersionRow>(
          'SELECT * FROM drive_file_versions WHERE file_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
          [input.fileId, input.cursor, limit],
        )
      : ctx.sql.query<VersionRow>(
          'SELECT * FROM drive_file_versions WHERE file_id = ? ORDER BY id DESC LIMIT ?',
          [input.fileId, limit],
        );
    const next = rows.length === limit ? rows[rows.length - 1]!.id : null;
    return { entries: rows, nextCursor: next } as unknown as HandlerOutput<
      (typeof driveOperations)['drive/file-versions']
    >;
  },

  'drive/list-folders': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read, folderRef(input.folderId)));
    return ctx.page<FolderRow>('folder', {
      ...input,
      filters: { parent_id: input.folderId },
    }) as Page<FolderRow>;
  },

  'drive/folder-by-path': async (ctx, input) => {
    // The path is UNIQUE per scope, so this is one row or none.
    const row = ctx.sql.query<FolderRow>('SELECT * FROM drive_folders WHERE path = ?', [
      input.path,
    ])[0];
    if (!row) return null;
    // A REFUSAL ANSWERS NULL TOO, rather than raising. A path lookup is the one read
    // where the two answers must be indistinguishable: "no such folder" and "not
    // yours" differ only in whether the path exists, and a caller that can tell them
    // apart can walk the tree it may not read, one guess at a time. The denial is
    // still recorded by `ctx.check` — it is the CALLER who learns nothing.
    const decision = await ctx.check(DRIVE_PERM.read, folderRef(row.id));
    return decision.allowed ? row : null;
  },

  'drive/record-text': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.write, fileRef(input.fileId)));
    const file = ctx.sql.query<FileRow>('SELECT * FROM drive_files WHERE id = ?', [input.fileId])[0];
    if (!file) throw substratError('not_found', `file not found: ${input.fileId}`);

    /**
     * The text must describe the version the file is AT, or it is not recorded.
     *
     * Extraction runs off the request, so two uploads in quick succession race:
     * a 20 MB PDF uploaded first can still be parsing when a 4 KB one lands
     * after it, and the slow one finishes last. Without this, the older text
     * overwrites the newer by `file_id` and both the search index and
     * `drive/file-text` silently regress to a superseded version — a wrong
     * answer that looks exactly like a right one.
     *
     * `current_version_id` is the comparison rather than "newest id wins",
     * because the question is which version the file points AT. A rollback to an
     * earlier version must make that earlier version's text current again, and a
     * monotonic id comparison would refuse it.
     *
     * A CONFLICT rather than a quiet no-op, and rather than a nullable return:
     * `emits.entityIdFrom` reads a field off this operation's output, so a
     * nullable output has no fields to resolve and the registry's inference
     * degrades. It is also the more honest answer — the caller asked to record a
     * fact about a version this file is not at, and 409 is what that is. The
     * extraction path treats it as the expected outcome it usually is.
     *
     * A file with no current version at all falls here too: there are no bytes
     * for text to be about.
     */
    if (file.current_version_id !== input.versionId) {
      throw substratError(
        'conflict',
        `file ${input.fileId} is at version ${file.current_version_id ?? 'none'}, not ${input.versionId}`,
      );
    }

    // Only `indexed` carries text. Taking the caller's word for it would let a
    // `failed` row sit in the FTS index answering searches, which is the exact
    // confusion `status` exists to prevent.
    const text = input.status === 'indexed' ? (input.text ?? '') : '';
    const existing = ctx.sql.query<FileTextRow>(
      'SELECT id FROM drive_file_text WHERE file_id = ?',
      [input.fileId],
    )[0];

    const row: FileTextRow = {
      // The id is STABLE across re-extraction: it is an entity in its own right,
      // and a grant or a link naming it must not be orphaned by a second run.
      id: existing?.id ?? ulid(),
      file_id: input.fileId,
      version_id: input.versionId,
      status: input.status,
      text,
      chars: text.length,
      extracted_at: ctx.now(),
      detail: input.detail ?? null,
    };

    if (existing) {
      ctx.sql.exec(
        'UPDATE drive_file_text SET version_id = ?, status = ?, text = ?, chars = ?, extracted_at = ?, detail = ? WHERE file_id = ?',
        [row.version_id, row.status, row.text, row.chars, row.extracted_at, row.detail, row.file_id],
      );
    } else {
      ctx.sql.exec(
        'INSERT INTO drive_file_text (id, file_id, version_id, status, text, chars, extracted_at, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [row.id, row.file_id, row.version_id, row.status, row.text, row.chars, row.extracted_at, row.detail],
      );
      // Only on insert: the edge is a fact about this row's identity, and
      // re-linking an existing one on every re-extraction would be a write with
      // nothing to say.
      ctx.link(fileTextRef(row.id), fileRef(row.file_id));
    }

    ctx.emit({
      type: 'drive.file-text-recorded',
      schemaVersion: 1,
      entity: fileRef(row.file_id),
      piiClass: 'none',
      payload: {
        file_id: row.file_id,
        version_id: row.version_id,
        status: row.status,
        chars: row.chars,
      },
    });
    return row;
  },

  'drive/file-text': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read, fileRef(input.fileId)));
    liveFile(ctx, input.fileId);
    const row = ctx.sql.query<FileTextRow>(
      'SELECT id, file_id, version_id, status, chars, extracted_at, detail FROM drive_file_text WHERE file_id = ?',
      [input.fileId],
    )[0];
    // Null is the answer, not the absence of one: it says nobody has looked yet.
    return row ?? null;
  },

  'drive/people-access': async (ctx) => {
    // Asking is a read: any member may know who administers the space they are in.
    assertAllowed(await ctx.check(DRIVE_PERM.read));
    // The answer. A member's honest answer is `false` — see the declaration for why this
    // is a boolean and not a refusal.
    return { canManage: (await ctx.check(DRIVE_PERM.manage)).allowed };
  },

  'drive/search': async (ctx, input) => {
    // The gate on ASKING. What comes back is gated per hit, below.
    assertAllowed(await ctx.check(DRIVE_PERM.read));

    const limit = input.limit ?? 20;
    // Over-fetch: hits the caller may not read are dropped after the check, and a
    // page that returns three results because seventeen were filtered reads as a
    // broken search. Bounded so a principal who can read nothing still does O(1)
    // work rather than walking the scope.
    const reach = Math.min(limit * 3, 100);

    const [byName, byText] = await Promise.all([
      ctx.search('file', input.term, { limit: reach }),
      ctx.search('file_text', input.term, { limit: reach }),
    ]);

    // A file_text hit is an id in ITS table; what the caller wants is the file.
    const textFileIds = new Map<string, number>();
    for (const hit of byText) {
      const row = ctx.sql.query<FileTextRow>('SELECT file_id FROM drive_file_text WHERE id = ?', [
        hit.id,
      ])[0];
      if (row && !textFileIds.has(row.file_id)) textFileIds.set(row.file_id, hit.rank);
    }

    // bm25: lower is better. A name match and a body match are the same question,
    // so they merge into one list — and a file matching BOTH is reported once, as
    // a name hit, because that is the stronger thing to say about it.
    const merged = new Map<string, { rank: number; via: 'name' | 'content' }>();
    for (const [id, rank] of textFileIds) merged.set(id, { rank, via: 'content' });
    for (const hit of byName) merged.set(hit.id, { rank: hit.rank, via: 'name' });

    const ranked = [...merged.entries()].sort((a, b) => a[1].rank - b[1].rank);

    const hits: (FileRow & { via: 'name' | 'content' })[] = [];
    for (const [fileId, { via }] of ranked) {
      if (hits.length === limit) break;
      // Per hit, and deliberately not a bulk filter: the checker's answer is the
      // only thing that knows about a grant three folders up. A principal with a
      // grant on one folder must not learn from a ranked list that a document
      // exists in another — an index that leaks existence is still a leak.
      if (!(await ctx.check(DRIVE_PERM.read, fileRef(fileId))).allowed) continue;
      const file = ctx.sql.query<FileRow>(
        "SELECT * FROM drive_files WHERE id = ? AND state = 'live'",
        [fileId],
      )[0];
      if (file) hits.push({ ...file, via });
    }
    return { hits };
  },
} satisfies {
  [K in keyof typeof driveOperations]: OperationHandler<
    HandlerInput<(typeof driveOperations)[K]>,
    HandlerOutput<(typeof driveOperations)[K]>
  >;
};

export const driveModule: ModuleRegistration = {
  manifest: driveManifest,
  migrations: driveMigrations,
  operationInputs: operationInputsOf(driveOperations),
  operations: operations as ModuleRegistration['operations'],
};
