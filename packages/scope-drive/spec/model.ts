/**
 * The drive's model, declared the way Substrat declares one (S9/S10).
 *
 * This is the first piece of the re-platform, and it is deliberately a *model*
 * rather than a port of `@canopy/store`. The store's shape cannot survive the
 * move: every table there carries `tenant_id` (the space) and every query
 * filters on it, because one database holds every space. Inside a scope there is
 * no such column — the scope *is* the space, tenancy is ambient, and a query
 * that names a space id is a query that has not been converted yet.
 *
 * What is modelled here is the drive's core triple and nothing else:
 *
 *   folder → file → file_version
 *
 * Shares, connector state, comments, calendars and the plugin tables are all out
 * of scope for this slice. They convert once this one is proven, which is the
 * order S10 asks for: reads first, then metadata writes, then bytes.
 *
 * Two shapes from the canopy store are deliberately NOT carried over:
 *
 * - `files.metadata.path` (a JSON-extracted virtual path). A path is how the
 *   drive is read and how permissions narrow, so it is a column here, not a
 *   field inside a JSON blob that only an index expression can reach.
 * - `file_permissions` (file_id, principal, role). Permission is the kernel's,
 *   granted on an entity and inherited through the declared parent edge. A
 *   module-owned permission table would be the second enforcement system D-17
 *   exists to prevent.
 */
import { defineEntities, defineOperations, z } from '@substrat-run/contracts';

export const driveEntities = defineEntities({
  /**
   * A folder. Explicit rather than derived: canopy's folders are virtual —
   * inferred from files' paths — with a side table so an *empty* folder can
   * exist. Inside a scope the derivation costs more than it saves, because a
   * folder is the thing a grant narrows onto, and a grant needs an entity with
   * an id.
   *
   * `path` is the full virtual path ("Documents/2026"), unique per scope. The
   * root is the empty string and is created by the migration, so every file has
   * a parent and the walk never special-cases the top.
   */
  folder: {
    table: 'drive_folders',
    fields: z.object({
      id: z.string(),
      parent_id: z.string(),
      path: z.string(),
      name: z.string(),
      created_at: z.string(),
      created_by: z.string(),
    }),
    key: ['path'],
    parents: ['folder'],
  },

  /**
   * A file's identity and where it currently points. The bytes are not here and
   * never were: `current_version_id` names the version, and a version names a
   * blob. That indirection is what makes versioning and connector-backed files
   * the same shape, and it is worth keeping through the move.
   */
  file: {
    table: 'drive_files',
    fields: z.object({
      id: z.string(),
      folder_id: z.string(),
      name: z.string(),
      current_version_id: z.string().nullable(),
      created_at: z.string(),
      updated_at: z.string(),
      deleted_at: z.string().nullable(),
    }),
    key: ['folder_id', 'name'],
    parents: ['folder'],
  },

  /**
   * One version of one file. `source` is 'blob' (we hold the bytes) or
   * 'external' (a connector does, and `external_key`/`etag` identify it there) —
   * the canopy distinction, carried over unchanged because it is load-bearing:
   * a connected space's file has versions it never stored.
   */
  file_version: {
    table: 'drive_file_versions',
    fields: z.object({
      id: z.string(),
      file_id: z.string(),
      source: z.string(),
      blob_ref: z.string().nullable(),
      external_key: z.string().nullable(),
      etag: z.string().nullable(),
      mime: z.string(),
      size: z.number(),
      created_at: z.string(),
      created_by: z.string(),
    }),
    parents: ['file'],
  },
});

/**
 * Three keys, mapping canopy's role ladder onto the kernel's model.
 *
 * Canopy has `viewer | editor | owner` per folder grant, resolved by `pathRole`
 * walking a path's ancestors. The kernel walks the declared `parents` edge
 * instead, so the ladder becomes three permission keys granted on a FOLDER
 * entity: hold `drive:read` on "Documents" and every folder and file beneath it
 * is readable, because the walk reaches file → folder → folder.
 *
 * `drive:manage` is what canopy calls owner — sharing and deletion — and it is
 * never held scope-wide, so one member's folders stay unreachable to another
 * unless a grant says otherwise.
 */
export const DRIVE_PERMISSIONS = ['drive:read', 'drive:write', 'drive:manage'] as const;

export const driveOperations = defineOperations(driveEntities, DRIVE_PERMISSIONS)({
  /**
   * The hot read, and the one S10 converts first.
   *
   * Canopy answers this with `SELECT … WHERE tenant_id = ? AND json_extract(metadata,'$.path') = ?`
   * against the shared database. Here it is one hop to the scope and then a
   * local query with no space id anywhere in it — which is the whole point of
   * the exercise, and what the test asserts.
   */
  'drive/list-folder': {
    summary: 'The files directly inside a folder',
    permission: { key: 'drive:read', entity: 'folder', idFrom: 'folderId' },
    input: z.object({ folderId: z.string() }),
    output: driveEntities.file.fields,
    // K-41: a read declares the columns a caller may sort and filter by, and the
    // kernel builds the index behind them. `folder_id` is the filter this read is,
    // so it is declared rather than composed in the handler.
    paged: { over: { entity: 'file', sortable: ['name', 'updated_at'], filterable: ['folder_id'] } },
    http: { method: 'GET', path: '/folders/{folderId}/files' },
  },

  'drive/create-folder': {
    summary: 'Create a folder inside another',
    permission: { key: 'drive:write', entity: 'folder', idFrom: 'parentId' },
    input: z.object({ parentId: z.string(), name: z.string().min(1) }),
    output: driveEntities.folder.fields,
    http: { method: 'POST', path: '/folders/{parentId}/folders' },
    emits: {
      entity: 'folder',
      entityIdFrom: 'id',
      type: 'drive.folder-created',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'parent_id', 'path'],
    },
  },

  /**
   * Metadata only: the bytes do not ride `invoke`. Substrat learned this on the
   * attachment surface and canopy learned it in the blob store — a structured-clone
   * pipe with per-scope serialization is the wrong path for megabytes. The version
   * row names where the bytes are; putting them there is a separate seam.
   */
  'drive/put-file': {
    summary: 'Create or supersede a file, recording a new version',
    permission: { key: 'drive:write', entity: 'folder', idFrom: 'folderId' },
    input: z.object({
      folderId: z.string(),
      name: z.string().min(1),
      source: z.enum(['blob', 'external']),
      blobRef: z.string().nullable().optional(),
      externalKey: z.string().nullable().optional(),
      etag: z.string().nullable().optional(),
      mime: z.string().min(1),
      size: z.number().int().nonnegative(),
    }),
    output: driveEntities.file.fields,
    http: { method: 'PUT', path: '/folders/{folderId}/files' },
    emits: {
      entity: 'file',
      entityIdFrom: 'id',
      type: 'drive.file-written',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'folder_id', 'current_version_id'],
    },
  },

  'drive/file-versions': {
    summary: "A file's versions, newest first",
    permission: { key: 'drive:read', entity: 'file', idFrom: 'fileId' },
    input: z.object({ fileId: z.string() }),
    output: driveEntities.file_version.fields,
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/files/{fileId}/versions' },
  },
});
