import { searchSnippet, SNIPPET_SCAN_LIMIT } from './search-snippet.js';
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
  dataSubjectId,
  PROVISION_SIBLING_KIND,
  provisionSiblingPayload,
  operationInputsOf,
  permissionKey,
  principalId,
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
import { driveOperations, installedPluginManifest } from '../spec/model.js';
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
  keep: number;
  blob_ref: string | null;
  external_key: string | null;
  etag: string | null;
  mime: string;
  size: number;
  created_at: string;
  created_by: string;
}

interface CommentRow {
  id: string; file_id: string; author: string; body: string; created_at: string; deleted_at: string | null;
}

interface DetailsRow {
  id: string; file_id: string; description: string; labels_json: string;
  revision: number; updated_at: string; updated_by: string;
}

interface FileTextRow {
  id: string;
  file_id: string;
  version_id: string;
  status: string;
  text: string;
  chars: number;
  extracted_at: string;
  extractor_revision: string;
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
/** A `drive_folder_shares` row joined to the roster, as the dialog reads it. */
interface ShareRow {
  folder_id: string;
  principal: string;
  permission: string;
  granted_at: string;
  granted_by: string;
  email: string | null;
  name: string | null;
}

/** A `drive_people` row, as the two operations above read and write it. */
interface PersonRow {
  principal: string;
  email: string | null;
  name: string | null;
  seen_at: string;
}

const fileRef = (id: string) => ({ entityType: 'file', entityId: id }) as const;
const versionRef = (id: string) => ({ entityType: 'file_version', entityId: id }) as const;
const fileTextRef = (id: string) => ({ entityType: 'file_text', entityId: id }) as const;

/** Events that invalidate a mirrored file row. Shares only change write/manage
 * authority, and text extraction is a search concern rather than listing metadata. */
const FILE_CHANGE_TYPES = [
  'drive.file-created',
  'drive.file-written',
  'drive.file-renamed',
  'drive.file-moved',
  'drive.file-trashed',
  'drive.file-restored',
] as const;
const FOLDER_CHANGE_TYPES = [
  'drive.folder-created',
  'drive.folder-renamed',
  'drive.folder-moved',
] as const;
const MIRROR_CHANGE_TYPES = [...FILE_CHANGE_TYPES, ...FOLDER_CHANGE_TYPES] as const;

interface MirrorChangeEvent {
  id: string;
  type: string;
  entity_type: string;
  entity_id: string;
}

interface PluginRow { id: string; plugin_id: string; principal: string; manifest_json: string; source: string; enabled: number; updated_at: string; source_kind: string; source_ref: string; resolved: string; source_sha256: string; granted_capabilities: string }
async function pluginForMutation(ctx: OperationContext, id: string, mutate = true) {
  assertAllowed(await ctx.check(DRIVE_PERM.read));
  const row = ctx.sql.query<PluginRow>('SELECT * FROM drive_plugin_installs WHERE id = ?', [id])[0];
  if (!row || (row.principal !== ctx.principal && row.principal !== 'space')) throw substratError('not_found', 'Plugin not found');
  if (mutate && row.principal === 'space') assertAllowed(await ctx.check(DRIVE_PERM.manage));
  return row;
}
const capabilityKeys = (caps: {kind:string;hosts?:string[]}[]) => [...new Set(caps.flatMap(cap => cap.kind === 'net:fetch' ? (cap.hosts ?? []).map(host => `net:fetch:${host}`) : [cap.kind]))].sort();
const pluginWeb = globalThis as unknown as {crypto:{subtle:{digest(algorithm:string,bytes:Uint8Array):Promise<ArrayBuffer>}};TextEncoder:new()=>{encode(source:string):Uint8Array}};
async function sourceDigest(source:string) {return [...new Uint8Array(await pluginWeb.crypto.subtle.digest('SHA-256',new pluginWeb.TextEncoder().encode(source)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');}
const operations = {
  'drive/request-space': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.manage));
    const previous = ctx.platformRequests({ kind: PROVISION_SIBLING_KIND, limit: 100 }).find(request => request.requestedBy === ctx.principal && provisionSiblingPayload.safeParse(request.payload).data?.slug === input.slug);
    if (previous && previous.status !== 'failed') return { id: previous.id, slug: input.slug, name: provisionSiblingPayload.parse(previous.payload).name };
    const payload = provisionSiblingPayload.parse(input);
    const id = ctx.requestPlatform({ kind: PROVISION_SIBLING_KIND, payload });
    return { id, slug: payload.slug, name: payload.name };
  },
  'drive/space-requests': async (ctx) => {
    assertAllowed(await ctx.check(DRIVE_PERM.manage));
    return { requests: ctx.platformRequests({ kind: PROVISION_SIBLING_KIND, limit: 100 }).filter(request => request.requestedBy === ctx.principal).flatMap(request => {
      const payload = provisionSiblingPayload.safeParse(request.payload);
      return payload.success ? [{ id: request.id, slug: payload.data.slug, name: payload.data.name, status: request.status, error: request.lastError, requestedAt: request.requestedAt }] : [];
    }) };
  },
  'drive/list-plugins': async (ctx) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read));
    const rows = ctx.sql.query<Omit<PluginRow,'source'>>('SELECT id, plugin_id, principal, manifest_json, enabled, updated_at, source_kind, source_ref, resolved, source_sha256, granted_capabilities FROM drive_plugin_installs WHERE principal IN (?, ?) ORDER BY plugin_id LIMIT 100', [ctx.principal, 'space']);
    return {plugins: rows.filter(row => {try {return installedPluginManifest.safeParse(JSON.parse(row.manifest_json)).success;}catch{return false;}})};
  },
  'drive/plugin-source': async (ctx,input) => {
    const row=await pluginForMutation(ctx,input.id,false);
    if(row.updated_at!==input.revision)throw substratError('conflict','This plugin changed. Reload the plugin list.');
    installedPluginManifest.parse(JSON.parse(row.manifest_json));
    return {...row,source_sha256:row.source_sha256 || await sourceDigest(row.source)};
  },
  'drive/save-plugin': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read));
    if (input.forSpace) assertAllowed(await ctx.check(DRIVE_PERM.manage));
    const manifest = installedPluginManifest.parse(input.manifest), principal = input.forSpace ? 'space' : ctx.principal;
    const previous = ctx.sql.query<PluginRow>('SELECT * FROM drive_plugin_installs WHERE principal = ? AND plugin_id = ?', [principal, manifest.id])[0];
    if ((previous?.updated_at ?? null) !== input.expectedRevision) throw substratError('conflict', 'This plugin changed. Reload before replacing it.');
    const nextCaps = capabilityKeys(manifest.capabilities);
    const oldCaps = previous ? capabilityKeys(JSON.parse(previous.granted_capabilities) as {kind:string;hosts?:string[]}[]) : [];
    if(previous && nextCaps.some(cap => !oldCaps.includes(cap)) && JSON.stringify(capabilityKeys(input.acceptCapabilities ?? [])) !== JSON.stringify(nextCaps)) throw substratError('conflict','Approve the complete new capability set before widening plugin access.');
    const bytes=new pluginWeb.TextEncoder().encode(input.source).length;
    const used=ctx.sql.query<{n:number}>('SELECT COALESCE(SUM(length(CAST(source AS BLOB))),0) AS n FROM drive_plugin_installs')[0]!.n;
    if(bytes>256000 || used - (previous ? new pluginWeb.TextEncoder().encode(previous.source).length : 0) + bytes > 5000000) throw substratError('conflict','Plugin source storage is limited to 256 KB per install and 5 MB per space.');
    const count = ctx.sql.query<{n: number}>('SELECT count(*) AS n FROM drive_plugin_installs WHERE principal = ?', [principal])[0]!.n;
    if (!previous && count >= 40) throw substratError('conflict', 'Uninstall a plugin before installing another (40 per person or space).');
    const row: PluginRow = {id: previous?.id ?? ulid(), plugin_id: manifest.id, principal, manifest_json: JSON.stringify(manifest), source: input.source, enabled: previous?.enabled ?? 1, updated_at: ulid(), source_kind: input.provenance?.kind ?? 'inline', source_ref: input.provenance?.ref ?? 'Client-supplied JavaScript', resolved: input.provenance?.resolved ?? '', source_sha256: await sourceDigest(input.source), granted_capabilities: JSON.stringify(manifest.capabilities)};
    ctx.sql.exec('INSERT INTO drive_plugin_installs (id, plugin_id, principal, manifest_json, source, enabled, updated_at, source_kind, source_ref, resolved, source_sha256, granted_capabilities) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET manifest_json=excluded.manifest_json, source=excluded.source, updated_at=excluded.updated_at, source_kind=excluded.source_kind, source_ref=excluded.source_ref, resolved=excluded.resolved, source_sha256=excluded.source_sha256, granted_capabilities=excluded.granted_capabilities', [row.id, row.plugin_id, row.principal, row.manifest_json, row.source, row.enabled, row.updated_at, row.source_kind, row.source_ref, row.resolved, row.source_sha256, row.granted_capabilities]);
    ctx.emit({type: 'drive.plugin-saved', schemaVersion: 1, entity: {entityType: 'plugin_install', entityId: row.id}, piiClass: 'none', payload: {pluginId: manifest.id}});
    return row;
  },
  'drive/toggle-plugin': async (ctx, input) => {
    const row = await pluginForMutation(ctx, input.id);
    row.enabled = input.enabled ? 1 : 0; row.updated_at = ulid();
    ctx.sql.exec('UPDATE drive_plugin_installs SET enabled = ?, updated_at = ? WHERE id = ?', [row.enabled, row.updated_at, row.id]);
    ctx.emit({type: 'drive.plugin-saved', schemaVersion: 1, entity: {entityType: 'plugin_install', entityId: row.id}, piiClass: 'none', payload: {pluginId: row.plugin_id}});
    return row;
  },
  'drive/remove-plugin': async (ctx, input) => {
    const row = await pluginForMutation(ctx, input.id);
    ctx.sql.exec('DELETE FROM drive_plugin_installs WHERE id = ?', [row.id]);
    ctx.emit({type: 'drive.plugin-removed', schemaVersion: 1, entity: {entityType: 'plugin_install', entityId: row.id}, piiClass: 'none', payload: {pluginId: row.plugin_id}});
    return {id: row.id};
  },
  'drive/changes': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read));
    const limit = input.limit ?? 50;
    const placeholders = MIRROR_CHANGE_TYPES.map(() => '?').join(', ');
    // The extra row answers hasMore without returning an event we have not scanned.
    // `id` is the spine's monotonic ULID and survives scope restore; a timestamp
    // cursor would drop events emitted by the same invocation.
    const events = ctx.sql.query<MirrorChangeEvent>(
      `SELECT id, type, entity_type, entity_id FROM _substrat_outbox ` +
        `WHERE type IN (${placeholders})` +
        (input.after ? ' AND id > ?' : '') +
        ' ORDER BY id LIMIT ?',
      [...MIRROR_CHANGE_TYPES, ...(input.after ? [input.after] : []), limit + 1],
    );
    const page = events.slice(0, limit);
    const changes: (
      | { id: string; type: string; entityType: 'file'; entityId: string; file: FileRow | null }
      | { id: string; type: string; entityType: 'folder'; entityId: string; folder: FolderRow | null }
    )[] = [];
    for (const event of page) {
      if (event.entity_type === 'file') {
        if (!(await ctx.check(DRIVE_PERM.read, fileRef(event.entity_id))).allowed) continue;
        const file = ctx.sql.query<FileRow>('SELECT * FROM drive_files WHERE id = ?', [event.entity_id])[0];
        changes.push({
          id: event.id, type: event.type, entityType: 'file', entityId: event.entity_id,
          file: file?.state === 'live' ? file : null,
        });
      } else if (event.entity_type === 'folder') {
        if (!(await ctx.check(DRIVE_PERM.read, folderRef(event.entity_id))).allowed) continue;
        const folder = ctx.sql.query<FolderRow>('SELECT * FROM drive_folders WHERE id = ?', [event.entity_id])[0];
        changes.push({
          id: event.id, type: event.type, entityType: 'folder', entityId: event.entity_id,
          folder: folder ?? null,
        });
      }
    }
    return {
      changes,
      cursor: page.at(-1)?.id ?? input.after ?? null,
      hasMore: events.length > limit,
    };
  },

  'drive/list-folder': async (ctx, input) => {
    // The declaration names the permission; the handler still asks the checker.
    // That split is the conversion of `authz.ts`: canopy's `pathRole(space, path)`
    // walked ancestors itself, and this walks the declared parent edge instead —
    // one call, and the answer carries its own `explain`.
    assertAllowed(await ctx.check(DRIVE_PERM.read, folderRef(input.folderId)));
    // The kernel composes the walk from `paged.over` — the sort vocabulary, the
    // keyset comparison and the index behind them are one declared thing. What is
    // left to the handler is the filter that says which folder.
    // `state: 'live'` is what keeps trashed files out of the drive's hot listing.
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

    if (input.expectedCurrentVersion !== undefined && input.expectedCurrentVersion !== file.current_version_id) {
      throw substratError('conflict', 'file changed — reload before saving');
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
      keep: 0,
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
    return { file, version, canWrite: (await ctx.check(DRIVE_PERM.write, fileRef(file.id))).allowed };
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

  'drive/add-comment': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read, fileRef(input.fileId)));
    liveFile(ctx, input.fileId);
    const row: CommentRow = { id: ulid(), file_id: input.fileId, author: ctx.principal, body: input.body, created_at: ctx.now(), deleted_at: null };
    ctx.sql.exec('INSERT INTO drive_file_comments (id, file_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)',
      [row.id, row.file_id, row.author, row.body, row.created_at]);
    ctx.link({ entityType: 'file_comment', entityId: row.id }, fileRef(row.file_id));
    ctx.emit({ type: 'drive.comment-added', schemaVersion: 1, entity: fileRef(row.file_id), piiClass: 'pseudonymous',
      subjectId: dataSubjectId.parse(row.author), payload: { id: row.id, file_id: row.file_id, author: row.author } });
    const person = ctx.sql.query<PersonRow>('SELECT * FROM drive_people WHERE principal = ?', [row.author])[0];
    return { ...row, authorLabel: person?.name || person?.email || row.author, canDelete: true };
  },

  'drive/delete-comment': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read, fileRef(input.fileId)));
    liveFile(ctx, input.fileId);
    const row = ctx.sql.query<CommentRow>('SELECT * FROM drive_file_comments WHERE id = ? AND file_id = ? AND deleted_at IS NULL', [input.commentId, input.fileId])[0];
    if (!row) throw substratError('not_found', 'comment not found');
    if (row.author !== ctx.principal) assertAllowed(await ctx.check(DRIVE_PERM.manage, fileRef(input.fileId)));
    const deleted_at = ctx.now();
    ctx.sql.exec('UPDATE drive_file_comments SET deleted_at = ? WHERE id = ?', [deleted_at, row.id]);
    ctx.emit({ type: 'drive.comment-deleted', schemaVersion: 1, entity: fileRef(row.file_id), piiClass: 'pseudonymous',
      subjectId: dataSubjectId.parse(row.author), payload: { id: row.id, file_id: row.file_id, author: row.author } });
    return { ...row, deleted_at };
  },

  'drive/list-comments': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read, fileRef(input.fileId)));
    liveFile(ctx, input.fileId);
    const limit = input.limit ?? 50;
    const rows = ctx.sql.query<CommentRow & { name: string | null; email: string | null }>(
      `SELECT c.*, p.name, p.email FROM drive_file_comments c LEFT JOIN drive_people p ON p.principal = c.author
       WHERE c.file_id = ? AND c.deleted_at IS NULL` + (input.cursor ? ' AND c.id > ?' : '') + ' ORDER BY c.id LIMIT ?',
      [input.fileId, ...(input.cursor ? [input.cursor] : []), limit + 1],
    );
    const canManage = (await ctx.check(DRIVE_PERM.manage, fileRef(input.fileId))).allowed;
    const entries = rows.slice(0, limit).map(({ name, email, ...row }) => ({
      ...row, authorLabel: name || email || row.author, canDelete: row.author === ctx.principal || canManage,
    }));
    return { entries, nextCursor: rows.length > limit ? entries[entries.length - 1]!.id : null } as unknown as HandlerOutput<
      (typeof driveOperations)['drive/list-comments']
    >;
  },

  'drive/file-details': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read, fileRef(input.fileId)));
    liveFile(ctx, input.fileId);
    const row = ctx.sql.query<DetailsRow>('SELECT * FROM drive_file_details WHERE file_id = ?', [input.fileId])[0];
    return {
      fileId: input.fileId, description: row?.description ?? '', labels: row ? JSON.parse(row.labels_json) as string[] : [],
      revision: row?.revision ?? 0, canWrite: (await ctx.check(DRIVE_PERM.write, fileRef(input.fileId))).allowed,
    };
  },

  'drive/update-file-details': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.write, fileRef(input.fileId)));
    liveFile(ctx, input.fileId);
    const row = ctx.sql.query<DetailsRow>('SELECT * FROM drive_file_details WHERE file_id = ?', [input.fileId])[0];
    if ((row?.revision ?? 0) !== input.expectedRevision) {
      throw substratError('conflict', 'details changed — reload before saving');
    }
    const labels = [...new Set(input.labels)];
    const revision = input.expectedRevision + 1;
    // Scope invocations are serialized and transactional; the revision comparison and
    // upsert cannot be separated by another writer. Labels are values, never authority.
    ctx.sql.exec(`INSERT INTO drive_file_details (id, file_id, description, labels_json, revision, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(file_id) DO UPDATE SET
      description = excluded.description, labels_json = excluded.labels_json, revision = excluded.revision,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [input.fileId, input.fileId, input.description, JSON.stringify(labels), revision, ctx.now(), ctx.principal]);
    ctx.link({ entityType: 'file_details', entityId: input.fileId }, fileRef(input.fileId));
    ctx.emit({ type: 'drive.file-details-updated', schemaVersion: 1, entity: fileRef(input.fileId), piiClass: 'none',
      payload: { fileId: input.fileId, revision } });
    return { fileId: input.fileId, description: input.description, labels, revision, canWrite: true };
  },

  'drive/keep-version': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.write, fileRef(input.fileId)));
    liveFile(ctx, input.fileId);
    const version = ctx.sql.query<VersionRow>(
      'SELECT * FROM drive_file_versions WHERE id = ? AND file_id = ?', [input.versionId, input.fileId],
    )[0];
    if (!version) throw substratError('not_found', 'version not found');
    const keep = input.keep ? 1 : 0;
    if (version.keep === keep) return version;
    ctx.sql.exec('UPDATE drive_file_versions SET keep = ? WHERE id = ? AND file_id = ?', [keep, version.id, input.fileId]);
    ctx.emit({
      type: 'drive.version-kept', schemaVersion: 1, entity: fileRef(input.fileId), piiClass: 'none',
      payload: { id: version.id, keep },
    });
    return { ...version, keep };
  },

  'drive/restore-version': async (ctx, input): Promise<FileRow> => {
    assertAllowed(await ctx.check(DRIVE_PERM.write, fileRef(input.fileId)));
    const file = liveFile(ctx, input.fileId);
    const target = ctx.sql.query<VersionRow>(
      'SELECT * FROM drive_file_versions WHERE id = ? AND file_id = ?', [input.versionId, file.id],
    )[0];
    if (!target) throw substratError('not_found', 'version not found');
    if (target.source !== 'blob' || !target.blob_ref) {
      throw substratError('validation_failed', 'only stored versions can be restored');
    }
    // Reuse the verified write path: it checks attachment ownership and existence,
    // links a new history row and emits the normal live/mirror invalidation.
    if (target.id === file.current_version_id) return file;
    return operations['drive/record-version'](ctx, {
      fileId: file.id, location: { source: 'blob', blobRef: target.blob_ref },
    });
  },

  'drive/get-version': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read, fileRef(input.fileId)));
    const file = liveFile(ctx, input.fileId);
    const version = ctx.sql.query<VersionRow>(
      'SELECT * FROM drive_file_versions WHERE id = ? AND file_id = ?',
      [input.versionId, file.id],
    )[0];
    if (!version) throw substratError('not_found', 'version not found');
    return { file, version };
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
    const params = {
      ...input,
      filters: { parent_id: input.folderId },
    };
    const page = ctx.page<FolderRow>('folder', params) as Page<FolderRow>;
    if (input.folderId !== ROOT_FOLDER_ID || !page.entries.some(folder => folder.id === ROOT_FOLDER_ID)) return page;
    // The root row is its own parent to anchor the folder permission tree. It is
    // not a visible child folder. Fetch one replacement so even a limit=1 page
    // starts with a real folder and its cursor still advances correctly.
    const entries = page.entries.filter(folder => folder.id !== ROOT_FOLDER_ID);
    if (!page.nextCursor) return { ...page, entries };
    const replacement = ctx.page<FolderRow>('folder', { ...params, cursor: page.nextCursor, limit: 1 }) as Page<FolderRow>;
    return { ...page, entries: [...entries, ...replacement.entries], nextCursor: replacement.nextCursor };
  },

  'drive/get-folder': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read, folderRef(input.folderId)));
    const folder = ctx.sql.query<FolderRow>('SELECT * FROM drive_folders WHERE id = ?', [input.folderId])[0];
    if (!folder) throw substratError('not_found', 'folder not found');
    return { ...folder, canManage: (await ctx.check(DRIVE_PERM.manage, folderRef(input.folderId))).allowed };
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
      'SELECT * FROM drive_file_text WHERE file_id = ?',
      [input.fileId],
    )[0];
    if (existing && existing.version_id === input.versionId && existing.status === input.status &&
        existing.text === text && existing.detail === (input.detail ?? null) &&
        existing.extractor_revision === input.extractorRevision) return existing;

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
      extractor_revision: input.extractorRevision,
      detail: input.detail ?? null,
    };

    if (existing) {
      ctx.sql.exec(
        'UPDATE drive_file_text SET version_id = ?, status = ?, text = ?, chars = ?, extracted_at = ?, detail = ?, extractor_revision = ? WHERE file_id = ?',
        [row.version_id, row.status, row.text, row.chars, row.extracted_at, row.detail, row.extractor_revision, row.file_id],
      );
    } else {
      ctx.sql.exec(
        'INSERT INTO drive_file_text (id, file_id, version_id, status, text, chars, extracted_at, detail, extractor_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [row.id, row.file_id, row.version_id, row.status, row.text, row.chars, row.extracted_at, row.detail, row.extractor_revision],
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
      'SELECT id, file_id, version_id, status, chars, extracted_at, detail, extractor_revision FROM drive_file_text WHERE file_id = ?',
      [input.fileId],
    )[0];
    // Null is the answer, not the absence of one: it says nobody has looked yet.
    return row ?? null;
  },

  'drive/list-extraction-candidates': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read));
    // A limit on ELIGIBLE rows can still scan the entire scope when few files
    // need work. Read a fixed window of file ids, then choose at most `limit`
    // candidates from it. The cursor tracks the last file EXAMINED, even if
    // none in the window needed extraction.
    const scanLimit = input.limit * 10;
    const rows = ctx.sql.query<{
      id: string; versionId: string | null; name: string; mime: string | null;
      blobRef: string | null; source: string | null; textId: string | null;
      textVersionId: string | null; status: string | null; extractorRevision: string | null;
    }>(
      `SELECT f.id, v.id AS versionId, f.name, v.mime, v.blob_ref AS blobRef,
              v.source, t.id AS textId, t.version_id AS textVersionId,
              t.status, t.extractor_revision AS extractorRevision
       FROM drive_files f
       LEFT JOIN drive_file_versions v ON v.id = f.current_version_id AND v.file_id = f.id
       LEFT JOIN drive_file_text t ON t.file_id = f.id
       WHERE f.state = 'live' AND f.id > ?
       ORDER BY f.id LIMIT ?`,
      [input.after ?? '', scanLimit + 1],
    );
    const files: { id: string; versionId: string; name: string; mime: string; blobRef: string }[] = [];
    let examined = 0;
    for (const row of rows.slice(0, scanLimit)) {
      examined += 1;
      if (row.versionId && row.blobRef && row.mime && row.source === 'blob' &&
          (!row.textId || row.textVersionId !== row.versionId || row.status === 'failed' ||
           (row.status === 'unsupported' && row.extractorRevision !== input.extractorRevision))) {
        files.push({ id: row.id, versionId: row.versionId, name: row.name, mime: row.mime, blobRef: row.blobRef });
      }
      if (files.length === input.limit) break;
    }
    return { files, next: rows.length > examined ? rows[examined - 1]!.id : null };
  },

  'drive/share-folder': async (ctx, input) => {
    // Sharing is an owner's act on this folder. Being able to write in it is not enough.
    assertAllowed(await ctx.check(DRIVE_PERM.manage, folderRef(input.folderId)));
    if (input.folderId === ROOT_FOLDER_ID) throw substratError('validation_failed', 'Share individual folders; use People for space-wide access.');
    // The folder has to exist, and a trashed one is not somewhere to hand out access to.
    const folder = ctx.sql.query<FolderRow>('SELECT * FROM drive_folders WHERE id = ?', [
      input.folderId,
    ])[0];
    if (!folder) throw substratError('not_found', `folder not found: ${input.folderId}`);

    const permission = permissionKey.parse(input.permission);
    const granted_at = ctx.now();

    /**
     * The grant FIRST, because it is the one that means anything.
     *
     * `ctx.grant` re-checks that this caller holds `permission` on this entity, so the
     * operation cannot hand out more than it has — and it throws when it cannot, which takes
     * the row below with it. The row exists only so the share can be SHOWN: nothing can ask
     * the kernel who holds a grant.
     */
    await ctx.grant(principalId.parse(input.principal), permission, folderRef(input.folderId));

    ctx.sql.exec(
      `INSERT INTO drive_folder_shares (folder_id, principal, permission, granted_at, granted_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(folder_id, principal, permission) DO UPDATE SET
         granted_at = excluded.granted_at, granted_by = excluded.granted_by`,
      [input.folderId, input.principal, input.permission, granted_at, ctx.principal],
    );

    ctx.emit({
      type: 'drive.folder-shared',
      schemaVersion: 1,
      entity: folderRef(input.folderId),
      piiClass: 'pseudonymous',
      subjectId: dataSubjectId.parse(input.principal),
      payload: { principal: input.principal, permission: input.permission },
    });

    return {
      folder_id: input.folderId,
      principal: input.principal,
      permission: input.permission,
      granted_at,
      granted_by: ctx.principal,
    };
  },

  'drive/unshare-folder': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.manage, folderRef(input.folderId)));

    // `ctx.revoke` carries the grant's guardrail in reverse: you may withdraw only what you
    // could have given. Nothing is read first — withdrawing a share that is not there is the
    // state the caller asked for, so it answers instead of refusing.
    await ctx.revoke(
      principalId.parse(input.principal),
      permissionKey.parse(input.permission),
      folderRef(input.folderId),
    );

    const removed = ctx.sql.exec(
      'DELETE FROM drive_folder_shares WHERE folder_id = ? AND principal = ? AND permission = ?',
      [input.folderId, input.principal, input.permission],
    );

    if (removed.changes > 0) {
      ctx.emit({
        type: 'drive.folder-unshared',
        schemaVersion: 1,
        entity: folderRef(input.folderId),
        piiClass: 'pseudonymous',
        subjectId: dataSubjectId.parse(input.principal),
        payload: { principal: input.principal, permission: input.permission },
      });
    }

    return {
      folder_id: input.folderId,
      principal: input.principal,
      permission: input.permission,
    };
  },

  'drive/list-folder-shares': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.manage, folderRef(input.folderId)));
    // Joined rather than fetched separately: a dialog that renders ULIDs first and names a
    // moment later is a dialog that flickers, and the roster row may simply not exist.
    const shares = ctx.sql.query<ShareRow>(
      `SELECT s.folder_id, s.principal, s.permission, s.granted_at, s.granted_by,
              p.email AS email, p.name AS name
         FROM drive_folder_shares s
         LEFT JOIN drive_people p ON p.principal = s.principal
        WHERE s.folder_id = ?
        ORDER BY p.name, p.email, s.principal, s.permission`,
      [input.folderId],
    );
    return { shares };
  },

  'drive/list-shared-folders': async (ctx) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read));
    const candidates = ctx.sql.query<FolderRow>(
      `SELECT DISTINCT f.* FROM drive_folders f
         JOIN drive_folder_shares s ON s.folder_id = f.id
        WHERE s.principal = ? ORDER BY f.path`,
      [ctx.principal],
    );
    // The projection supplies discovery, while the kernel still decides visibility.
    const folders: FolderRow[] = [];
    for (const folder of candidates) {
      if ((await ctx.check(DRIVE_PERM.read, folderRef(folder.id))).allowed) folders.push(folder);
    }
    return { folders };
  },

  'drive/record-person': async (ctx, input) => {
    // A member may record themselves; that is all this writes.
    assertAllowed(await ctx.check(DRIVE_PERM.read));
    const email = input.email ?? null;
    const name = input.name ?? null;
    const seen = ctx.now();
    const before = ctx.sql.query<Pick<PersonRow, 'email' | 'name'>>(
      'SELECT email, name FROM drive_people WHERE principal = ?', [ctx.principal],
    )[0];
    // `ctx.principal`, never an input: the fields say what to call the caller and the
    // context says who the caller is. There is no shape of this operation that lets one
    // person write another's row.
    ctx.sql.exec(
      `INSERT INTO drive_people (principal, email, name, seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(principal) DO UPDATE SET email = excluded.email, name = excluded.name,
         seen_at = excluded.seen_at`,
      [ctx.principal, email, name, seen],
    );
    if (!before || before.email !== email || before.name !== name) {
      // The display values stay in the row, never in the event. A repeated /api/me
      // only refreshes seen_at and must not flood the spine with identical facts.
      ctx.emit({
        type: 'drive.person-recorded',
        schemaVersion: 1,
        entity: { entityType: 'person', entityId: ctx.principal },
        piiClass: 'pseudonymous',
        subjectId: dataSubjectId.parse(ctx.principal),
        payload: { principal: ctx.principal },
      });
    }
    return { principal: ctx.principal, email, name, seen_at: seen };
  },

  'drive/forget-person': async (ctx, input) => {
    // Node-level: removing somebody from the space is not a folder's authority.
    assertAllowed(await ctx.check(DRIVE_PERM.manage));

    // What the drive RECORDED, which is all it can know: there is no read that enumerates
    // grants, so a grant made at the admin seam is invisible here. The worker's unbind is what
    // covers that gap — see the declaration.
    const held = ctx.sql.query<{ folder_id: string; permission: string }>(
      'SELECT folder_id, permission FROM drive_folder_shares WHERE principal = ?',
      [input.principal],
    );

    /**
     * The grants FIRST, one at a time, and the rows after.
     *
     * `ctx.revoke` carries the same guardrail as the grant — you may withdraw only what you
     * could have given — so an owner can take back any of these and somebody who cannot
     * would fail here, taking the whole operation with them rather than leaving a person
     * half removed.
     */
    const who = principalId.parse(input.principal);
    for (const grant of held) {
      await ctx.revoke(who, permissionKey.parse(grant.permission), folderRef(grant.folder_id));
    }
    ctx.sql.exec('DELETE FROM drive_folder_shares WHERE principal = ?', [input.principal]);
    ctx.sql.exec('DELETE FROM drive_plugin_installs WHERE principal = ?', [input.principal]);

    const forgotten =
      ctx.sql.exec('DELETE FROM drive_people WHERE principal = ?', [input.principal]).changes > 0;

    if (held.length > 0 || forgotten) {
      ctx.emit({
        type: 'drive.person-forgotten',
        schemaVersion: 1,
        entity: { entityType: 'person', entityId: input.principal },
        piiClass: 'pseudonymous',
        subjectId: dataSubjectId.parse(input.principal),
        payload: { principal: input.principal, revoked: held.length },
      });
    }

    return { principal: input.principal, revoked: held.length, forgotten };
  },

  'drive/list-people': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read));
    // Someone with a name or an address first — a row that can only show a ULID is the
    // least useful thing in a picker, and the bound means it is what gets cut.
    const people = ctx.sql.query<PersonRow>(
      `SELECT principal, email, name, seen_at FROM drive_people
       ORDER BY (name IS NULL AND email IS NULL), name, email
       LIMIT ?`,
      [input.limit ?? 100],
    );
    return { people };
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

    const [byName, byText, byDetails] = await Promise.all([
      !input.via || input.via === 'name' ? ctx.search('file', input.term, { limit: reach }) : [],
      !input.via || input.via === 'content' ? ctx.search('file_text', input.term, { limit: reach }) : [],
      !input.via || input.via === 'metadata' ? ctx.search('file_details', input.term, { limit: reach }) : [],
    ]);

    // A file_text hit is an id in ITS table; what the caller wants is the file.
    const textFileIds = new Map<string, number>();
    for (const hit of byText) {
      const row = ctx.sql.query<FileTextRow>('SELECT file_id FROM drive_file_text WHERE id = ?', [
        hit.id,
      ])[0];
      if (row && !textFileIds.has(row.file_id)) textFileIds.set(row.file_id, hit.rank);
    }

    // Explicit filters search the requested index directly: a name match does not
    // exclude a file that also matches its contents or metadata.
    // bm25: lower is better. A name match and a body match are the same question,
    // so they merge into one list — and a file matching BOTH is reported once, as
    // a name hit, because that is the stronger thing to say about it.
    const merged = new Map<string, { rank: number; via: 'name' | 'content' | 'metadata' }>();
    for (const [id, rank] of textFileIds) merged.set(id, { rank, via: 'content' });
    for (const hit of byDetails) {
      const details = ctx.sql.query<{ file_id: string }>('SELECT file_id FROM drive_file_details WHERE id = ?', [hit.id])[0];
      if (details) merged.set(details.file_id, { rank: hit.rank, via: 'metadata' });
    }
    for (const hit of byName) merged.set(hit.id, { rank: hit.rank, via: 'name' });

    const ranked = [...merged.entries()].sort((a, b) => a[1].rank - b[1].rank);

    const hits: (FileRow & { via: 'name' | 'content' | 'metadata'; snippet: string | null })[] = [];
    for (const [fileId, { via }] of ranked) {
      if (input.via && via !== input.via) continue;
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
      if (!file) continue;
      let snippet: string | null = null;
      if (via === 'content') {
        const text = ctx.sql.query<{ version_id: string; status: string; text: string }>(
          'SELECT version_id, status, substr(text, 1, ?) AS text FROM drive_file_text WHERE file_id = ?', [SNIPPET_SCAN_LIMIT, fileId],
        )[0];
        if (text?.version_id !== file.current_version_id || text.status !== 'indexed') continue;
        snippet = searchSnippet(text.text, input.term);
      } else if (via === 'metadata') {
        const details = ctx.sql.query<{ description: string; labels_json: string }>(
          'SELECT description, labels_json FROM drive_file_details WHERE file_id = ?', [fileId],
        )[0];
        if (details) {
          const description = searchSnippet(details.description, input.term);
          const labels = searchSnippet((JSON.parse(details.labels_json) as string[]).join(', '), input.term);
          snippet = description ? `Description: ${description}` : labels ? `Labels: ${labels}` : null;
        }
      }
      hits.push({ ...file, via, snippet });
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
