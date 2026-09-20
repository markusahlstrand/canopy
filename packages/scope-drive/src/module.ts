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
import { assertAllowed, ulid, type ModuleRegistration, type OperationHandler } from '@substrat-run/kernel';
import { DRIVE_PERM } from './manifest.js';
import { driveOperations } from '../spec/model.js';
import { driveManifest } from './manifest.js';
import { driveMigrations } from './migrations.js';

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

/** The entity refs the checks narrow onto — the drive's two pointable things. */
const folderRef = (id: string) => ({ entityType: 'folder', entityId: id }) as const;
const fileRef = (id: string) => ({ entityType: 'file', entityId: id }) as const;
const versionRef = (id: string) => ({ entityType: 'file_version', entityId: id }) as const;

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
    return ctx.page<FileRow>('file', { ...input, filters: { folder_id: input.folderId } }) as Page<FileRow>;
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

  'drive/put-file': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.write, folderRef(input.folderId)));
    if (!ctx.sql.query<FolderRow>('SELECT id FROM drive_folders WHERE id = ?', [input.folderId])[0]) {
      throw substratError('not_found', `folder not found: ${input.folderId}`);
    }
    const now = ctx.now();
    // Create-or-supersede, keyed by (folder, name) — the same identity the store's
    // UNIQUE index has, so an overwrite is a new VERSION and never a second file.
    const existing = ctx.sql.query<FileRow>(
      'SELECT * FROM drive_files WHERE folder_id = ? AND name = ?',
      [input.folderId, input.name],
    )[0];

    const file: FileRow = existing ?? {
      id: ulid(),
      folder_id: input.folderId,
      name: input.name,
      current_version_id: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    if (!existing) {
      ctx.sql.exec(
        'INSERT INTO drive_files (id, folder_id, name, current_version_id, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
        [file.id, file.folder_id, file.name, null, file.created_at, file.updated_at],
      );
      ctx.link(fileRef(file.id), folderRef(file.folder_id));
    }

    // One location, guaranteed by the declaration's discriminated union: the
    // columns the other source would use stay null because there is nothing to
    // read them from, not because a check remembered to blank them.
    const loc = input.location;
    const version: VersionRow = {
      id: ulid(),
      file_id: file.id,
      source: loc.source,
      blob_ref: loc.source === 'blob' ? loc.blobRef : null,
      external_key: loc.source === 'external' ? loc.externalKey : null,
      etag: loc.source === 'external' ? (loc.etag ?? null) : null,
      mime: input.mime,
      size: input.size,
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
      'UPDATE drive_files SET current_version_id = ?, updated_at = ?, deleted_at = NULL WHERE id = ?',
      [version.id, now, file.id],
    );

    const written: FileRow = { ...file, current_version_id: version.id, updated_at: now, deleted_at: null };
    ctx.emit({
      type: 'drive.file-written',
      schemaVersion: 1,
      entity: { entityType: 'file', entityId: written.id },
      piiClass: 'none',
      payload: { id: written.id, folder_id: written.folder_id, current_version_id: version.id },
    });
    return written;
  },

  'drive/file-versions': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read, fileRef(input.fileId)));
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
