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
import { defineEntities, defineOperations, emitModel, z } from '@substrat-run/contracts';

/**
 * One path segment: a folder or file name, never a path.
 *
 * `@canopy/store` enforces exactly this on a rename (`files.ts`, "a non-empty name
 * with no path separators") and it has to hold here too, harder — a name is
 * concatenated into `drive_folders.path`, so a name containing `/` would occupy a
 * path that belongs to a real nested folder while carrying the parent edge of a
 * root child. The permission hierarchy and the path hierarchy would then disagree,
 * which is the one thing the parent edge exists to prevent. Trimmed, because a
 * trailing space is invisible in every UI that renders it.
 */
export const segment = z
  .string()
  .trim()
  .min(1)
  .refine((v) => !v.includes('/') && !v.includes('\\'), {
    message: 'a name is one path segment: no / or \\',
  })
  .refine((v) => v !== '.' && v !== '..', { message: 'a name cannot be . or ..' });

export const installedPluginManifest = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/), name: z.string().trim().min(1).max(100), version: z.string().min(1).max(50), description: z.string().max(1000).optional(),
  capabilities: z.array(z.discriminatedUnion('kind', [z.object({kind: z.literal('item:read')}), z.object({kind: z.literal('item:write')}), z.object({kind: z.literal('net:fetch'), hosts: z.array(z.string().regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/).refine(host => !/\.(local|internal|localhost|lan|home|arpa)$/.test(host), 'Use a public DNS hostname')).min(1).max(10)})])).max(10),
  contributes: z.object({
    viewers: z.array(z.object({id: z.string().min(1).max(50), title: z.string().max(100).optional(), match: z.array(z.string().min(1).max(100)).min(1).max(20), fill: z.boolean().optional()})).max(10).optional(),
    detailView: z.object({id: z.string().min(1).max(50), title: z.string().min(1).max(100), nav: z.object({section: z.string().max(50)}).optional(), immersive: z.boolean().optional()}).optional(),
  }).refine(value => !!value.viewers?.length || !!value.detailView, 'A plugin needs a viewer or app contribution'),
});
export const storedPlugin = z.object({ id: z.string(), plugin_id: z.string(), principal: z.string(), manifest_json: z.string(), source: z.string(), enabled: z.number().int(), updated_at: z.string(), source_kind: z.string(), source_ref: z.string(), resolved: z.string(), source_sha256: z.string(), granted_capabilities: z.string() });

export const driveEntities = defineEntities({
  plugin_install: { table: 'drive_plugin_installs', fields: storedPlugin, key: ['principal', 'plugin_id'] },
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
      /**
       * `'live'` or `'trashed'`. The fact every read filters on, and a column rather
       * than a derivation because a kernel-composed page filters by equality only —
       * `deleted_at IS NULL` is not something a caller can ask for. `deleted_at` beside
       * it says WHEN, and the two are written together or not at all.
       */
      state: z.string(),
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
      /** Retention designation; current versions remain protected independently. */
      keep: z.number().int().min(0).max(1),
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

  /**
   * A file's extracted text, and — just as important — the STATE of having tried.
   *
   * A separate entity rather than a column on `file` for two reasons. The text is
   * unbounded and the file row is the hot read, so a `SELECT *` in the folder
   * listing must not drag a novel through it. And the kernel's FTS index is
   * maintained by triggers generated over a table's columns (#827), so what is
   * indexed is exactly this table and nothing on the path of an ordinary read.
   *
   * `status` is the half that makes the feature honest. "Indexed and matched
   * nothing" and "never looked at" are different answers, and a search UI that
   * conflates them lies to the person reading it:
   *
   *   indexed      text was extracted and is in `text`
   *   empty        the extractor ran and the document genuinely has no text layer
   *                (a scanned page with no OCR, an empty sheet)
   *   unsupported  no extractor handles this content type at all
   *   failed       an extractor ran and threw; `detail` says what
   *
   * NO ROW AT ALL is the fifth state and the one that cannot be a column value:
   * never extracted. Everything uploaded before this landed is in it.
   *
   * One row per FILE, not per version: search answers "which file", and keeping
   * every superseded version's text would grow the index without a reader. The
   * `version_id` records WHICH version the text came from, so a stale row is
   * detectable rather than merely old.
   */
  file_text: {
    table: 'drive_file_text',
    fields: z.object({
      id: z.string(),
      file_id: z.string(),
      version_id: z.string(),
      status: z.string(),
      /** Empty for every status but `indexed` — the index has nothing to hold. */
      text: z.string(),
      chars: z.number(),
      extracted_at: z.string(),
      extractor_revision: z.string(),
      /** Why, for `failed` and `unsupported`. Null otherwise. */
      detail: z.string().nullable(),
    }),
    key: ['file_id'],
    parents: ['file'],
  },

  file_comment: {
    table: 'drive_file_comments',
    fields: z.object({
      id: z.string(), file_id: z.string(), author: z.string(), body: z.string(),
      created_at: z.string(), deleted_at: z.string().nullable(),
    }),
    parents: ['file'],
    erasable: ['body'],
  },

  /** Optional description and labels, kept off the hot file-listing row. */
  file_details: {
    table: 'drive_file_details',
    fields: z.object({
      id: z.string(), file_id: z.string(), description: z.string(), labels_json: z.string(),
      revision: z.number().int(), updated_at: z.string(), updated_by: z.string(),
    }),
    key: ['file_id'], parents: ['file'],
  },

  /** Display identity only. The principal is the row key; no permission is granted on it. */
  person: {
    table: 'drive_people',
    fields: z.object({
      principal: z.string(),
      email: z.string().nullable(),
      name: z.string().nullable(),
      seen_at: z.string(),
    }),
    primaryKey: ['principal'],
    erasable: ['email', 'name'],
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

/**
 * A person as this drive displays them: a principal, and what to call it.
 *
 * Nothing is granted on a person and nothing pages over them. The declaration above
 * names the existing table so the roster events can name their actual entity.
 */
const drivePerson = driveEntities.person.fields;

/**
 * A share as the drive recorded it: which folder, who, and what they were given.
 *
 * `granted_by` is kept because "who let them in" is the first question asked when somebody
 * turns out to be somewhere they should not be.
 */
const driveShare = z.object({
  folder_id: z.string(),
  principal: z.string(),
  permission: z.string(),
  granted_at: z.string(),
  granted_by: z.string(),
});

export const fileDetails = z.object({
  fileId: z.string(), description: z.string(), labels: z.array(z.string()), revision: z.number().int(), canWrite: z.boolean(),
});

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
    paged: {
      over: { entity: 'file', sortable: ['name', 'updated_at'], filterable: ['folder_id', 'state'] },
    },
    http: { method: 'GET', path: '/folders/{folderId}/files' },
  },

  'drive/create-folder': {
    summary: 'Create a folder inside another',
    permission: { key: 'drive:write', entity: 'folder', idFrom: 'parentId' },
    input: z.object({ parentId: z.string(), name: segment }),
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
  /**
   * Create the file row, or return the one already at this (folder, name).
   *
   * Split from recording a version because bytes need somewhere to attach BEFORE
   * they exist: an attachment binds to an entity, and the entity has to be there to
   * bind to. So a write is three hops — ensure the file, put the bytes against it,
   * record the version that points at them — and each hop is honest about what it
   * did. A single `put-file` could only have pretended, by taking bytes through
   * `invoke`, which is the one thing the scope pipe must not carry.
   */
  'drive/ensure-file': {
    summary: 'Create a file, or return the existing one at this name',
    permission: { key: 'drive:write', entity: 'folder', idFrom: 'folderId' },
    input: z.object({ folderId: z.string(), name: segment }),
    output: driveEntities.file.fields,
    http: { method: 'POST', path: '/folders/{folderId}/files' },
    emits: {
      entity: 'file',
      entityIdFrom: 'id',
      type: 'drive.file-created',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'folder_id'],
    },
  },

  /**
   * Point a file at a new version. For a `blob` version the caller has already put
   * the bytes in the scope's attachment store and hands the id back here; for an
   * `external` one a connector holds them and `externalKey` identifies them there.
   */
  'drive/record-version': {
    summary: 'Record a new version and make it current',
    permission: { key: 'drive:write', entity: 'file', idFrom: 'fileId' },
    /**
     * `mime` and `size` live on the EXTERNAL branch only, and that asymmetry is the
     * point. For a blob version both are read off the attachment row the id names —
     * a row cannot claim a size or a type the stored bytes do not have, and a caller
     * reaching this operation directly (it carries a URL) cannot make it. For an
     * external version there is no local row to read, so the connector that holds the
     * bytes supplies them.
     */
    input: z.object({
      fileId: z.string(),
      /** Optional compare-and-swap for editors; omitted for ordinary uploads. */
      expectedCurrentVersion: z.string().nullable().optional(),
      location: z.discriminatedUnion('source', [
        // The attachment id. The bytes are already in the platform's per-tenant blob
        // store under a key derived from (scopeId, attachmentId), with a sha256
        // computed at upload — so a version can never be re-pointed at other content.
        z.object({ source: z.literal('blob'), blobRef: z.string().min(1) }),
        z.object({
          source: z.literal('external'),
          externalKey: z.string().min(1),
          etag: z.string().nullable().optional(),
          mime: z.string().min(1),
          size: z.number().int().nonnegative(),
        }),
      ]),
    }),
    output: driveEntities.file.fields,
    http: { method: 'POST', path: '/files/{fileId}/versions' },
    emits: {
      entity: 'file',
      entityIdFrom: 'id',
      type: 'drive.file-written',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'folder_id', 'current_version_id'],
    },
  },

  /**
   * One file and the version it currently points at — what a download resolves
   * through before it asks the attachment store for bytes.
   */
  'drive/get-file': {
    summary: 'A file and its current version',
    permission: { key: 'drive:read', entity: 'file', idFrom: 'fileId' },
    input: z.object({ fileId: z.string() }),
    output: z.object({
      file: driveEntities.file.fields,
      /** Null while a file exists but nothing has been written to it yet. */
      version: driveEntities.file_version.fields.nullable(),
      canWrite: z.boolean(),
    }),
    http: { method: 'GET', path: '/files/{fileId}' },
  },

  /**
   * Rename a file. A name is one segment and stays unique in its folder, so a rename
   * onto an occupied name is a conflict rather than a silent overwrite — the schema
   * says so too, and this is the error the UI gets to show instead of a 500.
   */
  'drive/rename-file': {
    summary: 'Rename a file',
    permission: { key: 'drive:write', entity: 'file', idFrom: 'fileId' },
    input: z.object({ fileId: z.string(), name: segment }),
    output: driveEntities.file.fields,
    http: { method: 'PATCH', path: '/files/{fileId}' },
    emits: {
      entity: 'file',
      entityIdFrom: 'id',
      type: 'drive.file-renamed',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'folder_id', 'name'],
    },
  },

  /**
   * Rename a folder, which moves the derived `path` of everything beneath it.
   *
   * This is where the model change either proves itself or is lost. Canopy addressed a
   * file BY its path, so a folder rename was a rewrite of every descendant's identity;
   * here `path` is a derived column and the parent edge is the identity, so a rename
   * touches paths and **nothing else** — no parent edge moves, and no grant changes
   * what it reaches. A test asserts exactly that, because it is the claim, not a
   * detail of the implementation.
   */
  'drive/rename-folder': {
    summary: 'Rename a folder and re-derive the paths beneath it',
    permission: { key: 'drive:write', entity: 'folder', idFrom: 'folderId' },
    input: z.object({ folderId: z.string(), name: segment }),
    output: driveEntities.folder.fields,
    http: { method: 'PATCH', path: '/folders/{folderId}' },
    emits: {
      entity: 'folder',
      entityIdFrom: 'id',
      type: 'drive.folder-renamed',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'path'],
    },
  },

  /**
   * Trash a file: recoverable, and not a delete. The bytes stay in the attachment
   * store and the version chain is intact — what changes is that every read but the
   * trash listing refuses it: `list-folder`, `search`, `get-file`, `file-versions` and
   * `file-text` all behave as though it were gone, and `record-version` refuses to
   * write to it. `not_found` rather than a state-specific error, because an error that
   * distinguished "trashed" from "never existed" would hand back the existence of
   * something the caller was not shown.
   *
   * Purging (dropping the attachment and the extracted text) is a retention concern and
   * deliberately not here.
   */
  /**
   * Move a file to another folder.
   *
   * **Access follows the move**, which is the decision recorded on #75: dragging a file
   * into a folder the family can read means the family can read it, because that is what
   * the gesture means to the person making it. The kernel's `relink` is what makes that
   * true — one atomic replace, so a grant above the old parent stops reaching the file and
   * one above the new parent starts, with no instant in between where it has no parent at
   * all. It tombstones the old edge rather than deleting it and emits `entity.relinked`, so
   * "who could reach this on which date" stays answerable.
   *
   * **Two entity checks, which is why this declares `narrows` rather than a single
   * `permission`.** A move needs write where the file is GOING and write where it is
   * LEAVING, and the declaration format carries one entity. Declaring only the
   * destination would be a partial truth in the artifact the permission registry is
   * derived from — and the conformance kit is right to refuse it: it grants the declared
   * key on the declared entity and expects the operation to proceed.
   *
   * Only the destination would also be a hole rather than a simplification. Access
   * follows a move, so a caller with write on a folder they can read could pull a file
   * out of one they cannot, and reading it afterwards would be legitimate — a way to
   * grant yourself access to content nobody shared. Both checks, and the reason written
   * where the next reader meets it.
   */
  'drive/move-file': {
    summary: 'Move a file into another folder',
    narrows: {
      reason: 'Checks drive:write on BOTH folders — where the file is going and where it is leaving',
      checks: ['drive:write'],
    },
    input: z.object({ fileId: z.string(), folderId: z.string() }),
    output: driveEntities.file.fields,
    http: { method: 'POST', path: '/files/{fileId}/move' },
    emits: {
      entity: 'file',
      entityIdFrom: 'id',
      type: 'drive.file-moved',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'folder_id'],
    },
  },

  /**
   * Move a folder, and everything under it, to another parent.
   *
   * Two things happen and both matter: the parent edge is relinked, so access follows for
   * the whole subtree at once, and the descendants' derived paths are re-written the way
   * `rename-folder` already does. A move into the folder's own descendant is refused — by
   * the kernel, which knows the edge graph, and again here, because the path rewrite would
   * otherwise build a cycle before the kernel ever saw it.
   *
   * `narrows` for the same reason as `move-file`: write is checked on the destination
   * parent AND on the parent being left, and one declared entity cannot say that.
   */
  'drive/move-folder': {
    summary: 'Move a folder into another folder',
    narrows: {
      reason: 'Checks drive:write on BOTH parents — the destination and the one being left',
      checks: ['drive:write'],
    },
    input: z.object({ folderId: z.string(), parentId: z.string() }),
    output: driveEntities.folder.fields,
    http: { method: 'POST', path: '/folders/{folderId}/move' },
    emits: {
      entity: 'folder',
      entityIdFrom: 'id',
      type: 'drive.folder-moved',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'parent_id', 'path'],
    },
  },

  'drive/trash-file': {
    summary: 'Move a file to the trash',
    permission: { key: 'drive:write', entity: 'file', idFrom: 'fileId' },
    input: z.object({ fileId: z.string() }),
    output: driveEntities.file.fields,
    http: { method: 'DELETE', path: '/files/{fileId}' },
    emits: {
      entity: 'file',
      entityIdFrom: 'id',
      type: 'drive.file-trashed',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'folder_id'],
    },
  },

  /**
   * Put a trashed file back.
   *
   * This cannot conflict, and that is a consequence of the trash rather than a gap: a
   * trashed file KEEPS its name, because `(folder_id, name)` is unique regardless of
   * state — so `ensure-file` and `rename-file` both refuse a name the trash holds, and
   * nothing can have taken it meanwhile. Freeing the name on trash instead would need
   * the uniqueness to become partial, which contradicts the declared `key`.
   */
  'drive/restore-file': {
    summary: 'Restore a file from the trash',
    permission: { key: 'drive:write', entity: 'file', idFrom: 'fileId' },
    input: z.object({ fileId: z.string() }),
    output: driveEntities.file.fields,
    http: { method: 'POST', path: '/files/{fileId}/restore' },
    emits: {
      entity: 'file',
      entityIdFrom: 'id',
      type: 'drive.file-restored',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'folder_id'],
    },
  },

  /**
   * What is in the trash, scope-wide rather than per folder: a trashed file's folder
   * is where it will go back to, not where a person looks for it.
   *
   * Visibility is a per-row proof walk, so the page may come back short — the same
   * shape `drive/list-folders` uses, for the same reason: what a caller may see is
   * decided by the checker, never by a WHERE clause on ownership.
   */
  'drive/list-trash': {
    summary: 'The files in the trash',
    narrows: {
      reason: 'Returns only trashed files the caller may read',
      checks: ['drive:read'],
    },
    output: driveEntities.file.fields,
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/trash' },
  },

  'drive/file-versions': {
    summary: "A file's versions, newest first",
    permission: { key: 'drive:read', entity: 'file', idFrom: 'fileId' },
    input: z.object({ fileId: z.string() }),
    output: driveEntities.file_version.fields,
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/files/{fileId}/versions' },
  },

  'drive/add-comment': {
    summary: 'Post a comment as the reader, preserving legacy viewer semantics',
    permission: { key: 'drive:read', entity: 'file', idFrom: 'fileId' },
    input: z.object({ fileId: z.string(), body: z.string().trim().min(1).max(10000) }),
    output: driveEntities.file_comment.fields.extend({ authorLabel: z.string(), canDelete: z.boolean() }),
    http: { method: 'POST', path: '/files/{fileId}/comments' },
    emits: {
      entity: 'file', entityIdFrom: 'file_id', type: 'drive.comment-added', schemaVersion: 1,
      piiClass: 'pseudonymous', subjectId: 'author', payload: ['id', 'file_id', 'author'],
    },
  },

  'drive/delete-comment': {
    summary: 'Delete a comment as its author or a file moderator',
    permission: { key: 'drive:read', entity: 'file', idFrom: 'fileId' },
    input: z.object({ fileId: z.string(), commentId: z.string() }),
    output: driveEntities.file_comment.fields,
    http: { method: 'DELETE', path: '/files/{fileId}/comments/{commentId}' },
    emits: {
      entity: 'file', entityIdFrom: 'file_id', type: 'drive.comment-deleted', schemaVersion: 1,
      piiClass: 'pseudonymous', subjectId: 'author', payload: ['id', 'file_id', 'author'],
    },
  },

  'drive/list-comments': {
    summary: 'Read a live file comment thread, oldest first',
    permission: { key: 'drive:read', entity: 'file', idFrom: 'fileId' },
    input: z.object({ fileId: z.string() }),
    output: driveEntities.file_comment.fields.extend({ authorLabel: z.string(), canDelete: z.boolean() }),
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/files/{fileId}/comments' },
  },

  'drive/file-details': {
    summary: 'Read a live file description and labels',
    permission: { key: 'drive:read', entity: 'file', idFrom: 'fileId' },
    input: z.object({ fileId: z.string() }), output: fileDetails,
    http: { method: 'GET', path: '/files/{fileId}/details' },
  },

  'drive/update-file-details': {
    summary: 'Replace a description and labels if their revision still matches',
    permission: { key: 'drive:write', entity: 'file', idFrom: 'fileId' },
    input: z.object({
      fileId: z.string(), description: z.string().max(10000),
      labels: z.array(z.string().trim().min(1).max(100)).max(20),
      expectedRevision: z.number().int().nonnegative(),
    }),
    output: fileDetails,
    http: { method: 'PATCH', path: '/files/{fileId}/details' },
    emits: {
      entity: 'file', entityIdFrom: 'fileId', type: 'drive.file-details-updated', schemaVersion: 1,
      piiClass: 'none', payload: ['fileId', 'revision'],
    },
  },

  'drive/keep-version': {
    summary: 'Mark or unmark a historical version to keep',
    permission: { key: 'drive:write', entity: 'file', idFrom: 'fileId' },
    input: z.object({ fileId: z.string(), versionId: z.string(), keep: z.boolean() }),
    output: driveEntities.file_version.fields,
    http: { method: 'PATCH', path: '/files/{fileId}/versions/{versionId}' },
    emits: {
      entity: 'file', entityIdFrom: 'file_id', type: 'drive.version-kept', schemaVersion: 1,
      piiClass: 'none', payload: ['id', 'keep'],
    },
  },

  'drive/restore-version': {
    summary: 'Restore stored historical content as a new current version',
    permission: { key: 'drive:write', entity: 'file', idFrom: 'fileId' },
    input: z.object({ fileId: z.string(), versionId: z.string() }),
    output: driveEntities.file.fields,
    http: { method: 'POST', path: '/files/{fileId}/versions/{versionId}/restore' },
    emits: {
      entity: 'file', entityIdFrom: 'id', type: 'drive.file-written', schemaVersion: 1,
      piiClass: 'none', payload: ['id', 'folder_id', 'current_version_id'],
    },
  },

  'drive/get-version': {
    summary: 'A live file and one of its historical versions',
    permission: { key: 'drive:read', entity: 'file', idFrom: 'fileId' },
    input: z.object({ fileId: z.string(), versionId: z.string() }),
    output: z.object({ file: driveEntities.file.fields, version: driveEntities.file_version.fields }),
    http: { method: 'GET', path: '/files/{fileId}/versions/{versionId}' },
  },

  /**
   * The folders directly inside a folder.
   *
   * The drive had no way to list them: its own front end renders one folder of
   * FILES and navigates by id, so nothing ever asked what was underneath. A
   * caller that browses a tree — the portal, which addresses folders by path and
   * shows folders beside files — needs both halves, and this is the missing one.
   */
  'drive/list-folders': {
    summary: 'The folders directly inside a folder',
    permission: { key: 'drive:read', entity: 'folder', idFrom: 'folderId' },
    input: z.object({ folderId: z.string() }),
    output: driveEntities.folder.fields,
    paged: { over: { entity: 'folder', sortable: ['name'], filterable: ['parent_id'] } },
    http: { method: 'GET', path: '/folders/{folderId}/folders' },
  },

  /**
   * The folder at a path — the read that lets a path-addressed caller in.
   *
   * Canopy's portal addresses a folder BY PATH ("Documents/2026"); this drive
   * addresses it by id, on purpose, so a rename stops rewriting every descendant.
   * Something has to bridge the two, and doing it in the caller would mean walking
   * the tree a segment at a time over the network.
   *
   * `resolved` rather than `idFrom`, because the id is not in the input: the
   * handler finds the row and then checks the folder it found, which is the same
   * authority `drive/list-folder` would have demanded for that id. The declaration
   * says so out loud, and the conformance kit records it as undrivable rather than
   * letting it read as a node check.
   */
  'drive/get-folder': {
    summary: 'Read a folder by id, including its current server path',
    permission: { key: 'drive:read', entity: 'folder', idFrom: 'folderId' },
    input: z.object({ folderId: z.string() }),
    output: driveEntities.folder.fields.extend({ canManage: z.boolean() }),
    http: { method: 'GET', path: '/folders/{folderId}/metadata' },
  },

  'drive/folder-by-path': {
    summary: 'The folder at a path, or null',
    permission: {
      key: 'drive:read',
      entity: 'folder',
      resolved: 'addressed by path, not id — the handler resolves the row and checks it',
    },
    input: z.object({ path: z.string() }),
    /** Null when nothing is there — indistinguishable from a folder you may not read. */
    output: driveEntities.folder.fields.nullable(),
    http: { method: 'GET', path: '/folders/by-path' },
  },

  /**
   * Record what extraction found — including that it found nothing, and why.
   *
   * Written by the host's extraction driver rather than by a person, but an
   * ordinary permission-checked operation all the same: it writes a row in this
   * scope, so it goes through the same door as every other write. `drive:write`
   * on the FILE, because that is exactly the authority "supersede this file's
   * content" already carries, and the text is a fact about the content.
   *
   * Idempotent per file: re-extracting replaces the row, so a re-run after a
   * failure heals rather than accumulating.
   */
  'drive/record-text': {
    summary: 'Record the extracted text of a file, or why there is none',
    permission: { key: 'drive:write', entity: 'file', idFrom: 'fileId' },
    input: z.object({
      fileId: z.string(),
      /** The version the text was read from — a stale row is detectable, not just old. */
      versionId: z.string(),
      extractorRevision: z.string().default('pdf-v1'),
      status: z.enum(['indexed', 'empty', 'unsupported', 'failed']),
      /** Present for `indexed`; ignored otherwise, because nothing else has text. */
      text: z.string().optional(),
      detail: z.string().nullable().optional(),
    }),
    output: driveEntities.file_text.fields,
    emits: {
      entity: 'file',
      entityIdFrom: 'file_id',
      type: 'drive.file-text-recorded',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['file_id', 'version_id', 'status', 'chars'],
    },
  },

  /**
   * What extraction found in a file — or `null`, which is its own answer.
   *
   * This read is what makes the state vocabulary usable rather than merely
   * recorded. `null` is "never extracted"; a row with `status: 'empty'` is "we
   * looked and there is no text layer". A UI that cannot tell those apart shows
   * "no results" for both and is lying about one of them.
   *
   * The text itself is deliberately NOT here: it is the document, the caller can
   * already download it, and a status read that drags a novel along is a status
   * read nobody puts in a list view.
   */
  'drive/file-text': {
    summary: 'What extraction found in a file, or null if it was never tried',
    permission: { key: 'drive:read', entity: 'file', idFrom: 'fileId' },
    input: z.object({ fileId: z.string() }),
    output: driveEntities.file_text.fields.omit({ text: true }).nullable(),
    http: { method: 'GET', path: '/files/{fileId}/text' },
  },

  /** Bounded, keyset-paged work for the system extraction job. Each call scans at most 10 × limit file rows. */
  'drive/list-extraction-candidates': {
    summary: 'List current blob versions needing text extraction',
    permission: 'drive:read',
    input: z.object({ after: z.string().optional(), limit: z.number().int().min(1).max(50), extractorRevision: z.string() }),
    output: z.object({
      files: z.array(z.object({ id: z.string(), versionId: z.string(), name: z.string(), mime: z.string(), blobRef: z.string() })),
      next: z.string().nullable(),
    }),
  },

  /**
   * Find files by NAME or by what is inside them, in one ranked list.
   *
   * Two searchable entities feed this — `file.name` since the drive existed, and
   * `file_text.text` since extraction — and `SearchHit.rank` exists precisely so
   * a caller can merge two entity types into one list. A filename match and a
   * body match are the same question asked by the person typing.
   *
   * The node-level `drive:read` here is the gate on ASKING; it is not the gate on
   * what comes back. Every hit is re-checked against the file it belongs to
   * before it joins the result, so a principal holding a grant on one folder
   * cannot learn from a ranked list that a document exists in another. The
   * kernel's index answers ids and says to hydrate through your own read path —
   * this is that read path, and the check is what makes it one.
   */
  /**
   * Share a folder with someone, which is the whole of #79.
   *
   * Everything beneath it comes with it: the kernel walks the declared `parents` edge, so a
   * grant on "Papers" reaches every folder and file under it without a row per descendant.
   * That is the design `provision.ts` states — members read the space, writing is granted on
   * a folder — expressed as an operation at last.
   *
   * **Two writes, and the second is only for looking at.** `ctx.grant` is what makes the
   * access real; the row in `drive_folder_shares` exists because nothing can ask the kernel
   * who holds a grant, so a share dialog would otherwise have nothing to show. They commit
   * together — a grant made by an operation that throws never happened — and if they ever
   * part company the row is the one that grants nothing.
   *
   * `drive:manage` on the folder is the gate: sharing is an owner's act on that folder, not
   * a right that comes with being able to write in it. The kernel adds its own bound on top,
   * and it is the one that matters — `ctx.grant` re-checks that the CALLER holds what it is
   * handing out, so no operation can give away more than it has. Delegation, never
   * elevation.
   *
   * Read is not shareable, and its absence is the model: a member already reads the whole
   * space, so "share read" would be a no-op dressed as an action.
   */
  'drive/share-folder': {
    summary: 'Give someone write or manage on a folder and everything under it',
    permission: { key: 'drive:manage', entity: 'folder', idFrom: 'folderId' },
    input: z.object({
      folderId: z.string(),
      /** Who gets it. A principal, which is why the roster exists to put a name to one. */
      principal: z.string().min(1),
      permission: z.enum(['drive:write', 'drive:manage']),
    }),
    output: driveShare,
    http: { method: 'POST', path: '/folders/{folderId}/shares' },
    emits: {
      entity: 'folder',
      entityIdFrom: 'folder_id',
      type: 'drive.folder-shared',
      schemaVersion: 1,
      // The principal is in the payload: "who was given access to what" is the event an
      // audit exists for, and a share event without the grantee says nothing.
      piiClass: 'pseudonymous',
      subjectId: 'principal',
      payload: ['principal', 'permission'],
    },
  },

  /**
   * Take a share back.
   *
   * The same gate and the same pair of writes in reverse. `ctx.revoke` carries the same
   * guardrail as the grant — you may withdraw only what you could have given — so this
   * cannot be used to strip access somebody else conferred at a level above you.
   *
   * Idempotent on purpose: withdrawing a share that is not there answers rather than
   * refusing, because the state the caller wanted is the state they get.
   */
  'drive/unshare-folder': {
    summary: 'Withdraw a share from a folder',
    permission: { key: 'drive:manage', entity: 'folder', idFrom: 'folderId' },
    input: z.object({
      folderId: z.string(),
      principal: z.string().min(1),
      permission: z.enum(['drive:write', 'drive:manage']),
    }),
    output: z.object({ folder_id: z.string(), principal: z.string(), permission: z.string() }),
    http: { method: 'DELETE', path: '/folders/{folderId}/shares' },
    emits: {
      entity: 'folder',
      entityIdFrom: 'folder_id',
      type: 'drive.folder-unshared',
      schemaVersion: 1,
      piiClass: 'pseudonymous',
      subjectId: 'principal',
      payload: ['principal', 'permission'],
    },
  },

  /**
   * Who a folder is shared with — the drive's own record, not the kernel's.
   *
   * There is no read that enumerates grants, so this is a projection and it says so. What it
   * is good for is a dialog; what it must not be used for is a decision. Every access
   * question goes through `ctx.check`, which reads the tuples this table merely mirrors.
   *
   * Display identity comes along, because a list of ULIDs is not a list of people — the
   * roster is joined here rather than fetched separately so the dialog cannot render half of
   * itself while the other half is in flight.
   *
   * `drive:manage` to look: who else has access is an administrative question about a
   * folder, not something every reader of it needs to know.
   */
  'drive/list-folder-shares': {
    summary: 'Who this folder is shared with, as the drive recorded it',
    permission: { key: 'drive:manage', entity: 'folder', idFrom: 'folderId' },
    input: z.object({ folderId: z.string() }),
    output: z.object({
      shares: z.array(
        driveShare.extend({
          /** From the roster, and null for somebody this install has never seen sign in. */
          email: z.string().nullable(),
          name: z.string().nullable(),
        }),
      ),
    }),
    http: { method: 'GET', path: '/folders/{folderId}/shares' },
  },

  'drive/list-shared-folders': {
    summary: 'Folders shared directly with the caller in this space',
    permission: 'drive:read',
    input: z.object({}),
    output: z.object({ folders: z.array(driveEntities.folder.fields) }),
    http: { method: 'GET', path: '/folders/shared-with-me' },
  },

  /**
   * Remember what to call the caller — and no route, deliberately.
   *
   * The kernel deals in principals, and a principal is a ULID. Sharing a folder means
   * picking a PERSON, so something has to hold the difference between `01JBQ…` and
   * "bjorn@example.com". Nothing in the platform does: the identity directory maps a
   * subject to a principal and keeps no display identity, and the invite row that carried
   * an email stops existing the moment it is accepted.
   *
   * **No `http` block, which is the security property.** The verified subject exists only
   * in the worker — it comes off the session, from the issuer's claims — so the worker is
   * the only caller that can say who somebody is. Exposed as a route, this would let any
   * member write any name and address onto their own row and appear in a share dialog as
   * somebody else. `drive/record-text` omits its route for a related reason.
   *
   * The identity written is `ctx.principal`, never an input: the fields say what to call
   * the caller, and the context says who the caller is.
   */
  'drive/record-person': {
    summary: 'Remember what to call the caller (worker-only: no HTTP route)',
    permission: 'drive:read',
    input: z.object({
      /** Both nullable: an issuer need not release either claim. */
      email: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
    }),
    output: drivePerson,
    emits: {
      entity: 'person',
      entityIdFrom: 'principal',
      type: 'drive.person-recorded',
      schemaVersion: 1,
      piiClass: 'pseudonymous',
      subjectId: 'principal',
      payload: ['principal'],
    },
  },

  /**
   * Take everything this space gave a person (#79).
   *
   * The other half of membership, and the reason it is one operation rather than a loop in
   * the worker: removing somebody has to take their SHARES with it, and the shares are the
   * drive's own — the worker can revoke a scope role and unbind a subject, and would leave
   * behind every folder grant the person held. A removal that leaves grants standing is the
   * worst kind: the roster stops naming them and the access remains.
   *
   * What it does, all in one transaction: revoke every folder grant RECORDED for them,
   * delete those rows, and forget what we called them. What it does NOT do is the membership
   * itself — the scope role and the subject binding are the platform's, and the worker takes
   * those either side of this call.
   *
   * **Recorded is the load-bearing word.** Nothing enumerates kernel grants — that absence is
   * why this projection exists at all — so a grant made through the platform's admin seam has
   * no row here and this cannot revoke it. That is why the worker unbinds the subject FIRST:
   * an unbound subject resolves to nobody on every request, so authority this operation could
   * not see becomes unreachable rather than merely unrevoked. Read alone, this operation is not
   * a removal and must not be presented as one, which is also why it has no route.
   *
   * `drive:manage` node-level, like `people-access`: administering who is in a space is not
   * something a grant on one folder can confer, and the kernel's narrowing rule is what
   * keeps that true.
   *
   * Idempotent. Somebody with no grants and no roster row is somebody already forgotten,
   * and answering is more useful than refusing — a removal that fails halfway will be
   * retried, and the retry must be able to finish.
   *
   * **No `http` block, and here the reason is that this is HALF of an act.** Removing somebody
   * is three things: their folder grants (this), their role, and their subject binding — and
   * the last two are the platform's, so only the worker can do all three. A derived route
   * would let a caller do this one alone and believe somebody had been removed, when what
   * they would have is a member who still reads the whole space. The worker's own
   * `DELETE /api/people/:principal` is the only way in.
   */
  'drive/forget-person': {
    summary: "Revoke a person's folder grants and forget them (worker-only: no HTTP route)",
    permission: 'drive:manage',
    input: z.object({ principal: z.string().min(1) }),
    output: z.object({
      principal: z.string(),
      /** How many grants were taken back — 0 when there was nothing to take. */
      revoked: z.number().int(),
      /** Whether a roster row existed to delete. */
      forgotten: z.boolean(),
    }),
    emits: {
      entity: 'person',
      entityIdFrom: 'principal',
      type: 'drive.person-forgotten',
      schemaVersion: 1,
      piiClass: 'pseudonymous',
      subjectId: 'principal',
      payload: ['principal', 'revoked'],
    },
  },

  /**
   * The people this install has seen in this space — the share dialog's picker.
   *
   * A projection of sign-ins, not the roster of record. Membership is a role at this node
   * and the kernel owns it; this answers "what do we call them", so a member who has never
   * signed in here is absent while still being a member. The UI has to say that rather than
   * present this as everyone.
   *
   * Not kernel-paged. A space's people are tens, not thousands — `limit` bounds it so the
   * answer cannot grow without one, and when a space needs a keyset walk over its members
   * it needs a picker with a search box, which is a different operation from this.
   */
  'drive/list-people': {
    summary: 'The people this install has seen in this space',
    permission: 'drive:read',
    /**
     * An object, even when empty. `.default({})` would let a bare `invoke` with no
     * argument through, but it widens the inferred input of every OTHER handler in the
     * registry to `| undefined` — one operation's convenience paid for by unrelated
     * handlers guarding a value they always receive. The derived GET builds `{}` from an
     * empty query string, so this only ever bites a hand-written caller.
     */
    input: z.object({ limit: z.number().int().positive().max(200).optional() }),
    output: z.object({ people: z.array(drivePerson) }),
    http: { method: 'GET', path: '/people' },
  },

  /**
   * May the caller manage the people in this space?
   *
   * An app-side `ScopeStub` can only `invoke` — there is no route-level permission check
   * to be had — so a decision a ROUTE needs has to be an operation. This is that
   * operation, and the platform's own invite routes are what needs it: they take an
   * admin gate from the vertical (`requireAdmin`) and the vertical has nowhere else to
   * ask.
   *
   * Two checks with different jobs, which is why the answer is a boolean rather than a
   * refusal. `drive:read` node-level is the gate on ASKING — any member of the space may
   * know whether they are the one who administers it, and the People surface needs that
   * to decide what to render. `drive:manage` is the answer, and a member's honest answer
   * is `false`, not a 403: a screen that has to provoke an error to find out what it may
   * show has to treat every error as that answer, including the ones that are not.
   *
   * Node-level on purpose (a bare key, no entity). `drive:manage` narrowed to a folder is
   * sharing THAT folder, which is a different authority from adding a person to the
   * space — and the kernel's own narrowing rule says so: a narrowed grant does not
   * satisfy an unnarrowed check, or sharing one folder would launder into administering
   * everyone.
   */
  'drive/people-access': {
    summary: 'Whether the caller may manage the people in this space',
    permission: 'drive:read',
    output: z.object({ canManage: z.boolean() }),
    http: { method: 'GET', path: '/people/access' },
  },

  'drive/search': {
    summary: 'Find files by name, content, description or labels',
    permission: 'drive:read',
    input: z.object({
      term: z.string().min(2),
      via: z.enum(['name', 'content', 'metadata']).optional(),
      limit: z.number().int().positive().max(50).optional(),
    }),
    output: z.object({
      hits: z.array(
        driveEntities.file.fields.extend({
          /** Which index matched — the UI says "in the name" or "in the document". */
          via: z.enum(['name', 'content', 'metadata']),
          snippet: z.string().nullable(),
        }),
      ),
    }),
    http: { method: 'GET', path: '/search' },
  },

  /**
   * The offline-mirror projection over the scope's event spine. Event ids are
   * monotonic in this scope; the cursor is the LAST SCANNED id, even when the caller
   * was not allowed to see that entity. A short page can therefore still advance.
   * Rows are hydrated from current state so an old write never resurrects a
   * file that has since been trashed. This is a metadata feed, not a byte feed.
   *
   * The outbox is a kernel table, so K-41 cannot compose this read from an entity.
   * Rule 3 permits a read-only spine projection while Substrat #1582 develops a
   * supported scope-wide helper. Every returned entity is checked separately.
   */
  'drive/request-space': {
    summary: 'Create a shared space', permission: 'drive:manage',
    input: z.object({ name: z.string().trim().min(1).max(100), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), owner: z.string().length(26) }),
    output: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  },
  'drive/space-requests': {
    summary: 'Your space creation requests', permission: 'drive:manage', input: z.object({}),
    output: z.object({ requests: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string(), status: z.enum(['pending', 'done', 'failed']), error: z.string().nullable() })) }),
  },
  'drive/list-plugins': {
    summary: 'Installed plugins for this person and space', permission: 'drive:read', input: z.object({}), output: z.object({plugins: z.array(storedPlugin.omit({source: true}))}), http: {method: 'GET', path: '/plugins'},
  },
  'drive/plugin-source': {summary:'Load one accessible plugin source revision',permission:'drive:read',input:z.object({id:z.string(),revision:z.string()}),output:storedPlugin,http:{method:'GET',path:'/plugins/{id}/source'}},
  'drive/save-plugin': {
    summary: 'Install or update a sandboxed plugin', permission: 'drive:read',
    input: z.object({manifest: installedPluginManifest, source: z.string().min(1).max(256000), forSpace: z.boolean().optional(), acceptCapabilities: installedPluginManifest.shape.capabilities.optional(), provenance: z.object({kind:z.enum(['inline','github','npm','zip','bundled']),ref:z.string().max(500),resolved:z.string().max(200)}).optional(), expectedRevision: z.string().nullable()}), output: storedPlugin,
    emits: {type: 'drive.plugin-saved', entity: 'plugin_install', entityIdFrom: 'id', schemaVersion: 1, piiClass: 'none'}, http: {method: 'PUT', path: '/plugins'},
  },
  'drive/toggle-plugin': {
    summary: 'Enable or disable an installed plugin', permission: 'drive:read', input: z.object({id: z.string(), enabled: z.boolean()}), output: storedPlugin,
    emits: {type: 'drive.plugin-saved', entity: 'plugin_install', entityIdFrom: 'id', schemaVersion: 1, piiClass: 'none'}, http: {method: 'PATCH', path: '/plugins/{id}'},
  },
  'drive/remove-plugin': {
    summary: 'Uninstall a plugin', permission: 'drive:read', input: z.object({id: z.string()}), output: z.object({id: z.string()}),
    emits: {type: 'drive.plugin-removed', entity: 'plugin_install', entityIdFrom: 'id', schemaVersion: 1, piiClass: 'none'}, http: {method: 'DELETE', path: '/plugins/{id}'},
  },
  'drive/changes': {
    summary: 'Drive metadata changes after an event cursor',
    permission: 'drive:read',
    input: z.object({
      after: z.string().length(26).optional(),
      limit: z.number().int().positive().max(100).optional(),
    }),
    output: z.object({
      changes: z.array(z.discriminatedUnion('entityType', [
        z.object({
          id: z.string(), type: z.string(), entityType: z.literal('file'), entityId: z.string(),
          /** Null means remove this row from the metadata mirror. */
          file: driveEntities.file.fields.nullable(),
        }),
        z.object({
          id: z.string(), type: z.string(), entityType: z.literal('folder'), entityId: z.string(),
          folder: driveEntities.folder.fields.nullable(),
        }),
      ])),
      cursor: z.string().nullable(),
      hasMore: z.boolean(),
    }),
    http: { method: 'GET', path: '/changes' },
  },
});

/**
 * The registry rendered to plain JSON — the artifact of record.
 *
 * `substrat push` reads the `model.json` this emits beside the vertical's
 * package.json, and a version pushed without one records no entity model at all:
 * the dashboard's Model tab is then empty for code that plainly has a model. The
 * TypeScript above stays the only declaration; this export is what makes it
 * readable by everything that is not a TypeScript compiler.
 *
 * Emitted from HERE rather than from the vertical, because the entities are
 * declared here — the vertical bundles this package and owns no model of its own.
 * `apps/drive-vertical/scripts/emit-model.mjs` renders it to the package root the
 * push actually reads.
 *
 * No `version` is passed: that field is a claim a module makes about its own
 * schema version, and the drive does not make one yet. Omitted beats defaulted.
 */
export const driveModel = emitModel(driveEntities);
