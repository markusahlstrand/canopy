import { substratError, type FileSourceChange } from '@substrat-run/contracts';
import { assertAllowed, ulid, type OperationContext } from '@substrat-run/kernel';
import { DRIVE_PERM } from './manifest.js';
import { segment } from '../spec/model.js';

type Item = { entity_id: string; kind: string; status: string };
type Folder = { id: string; parent_id: string; path: string };
type File = { id: string; folder_id: string; name: string; state: string; current_version_id: string | null };
const ref = (entityType: string, entityId: string) => ({ entityType, entityId });

/** Land source identities into ordinary drive rows; repeats preserve ids and version history. */
export async function landSourceChange(ctx: OperationContext, change: FileSourceChange): Promise<{ entity?: { entityType: string; entityId: string }; ok?: boolean }> {
  assertAllowed(await ctx.check(DRIVE_PERM.landSource));
  const held = ctx.sql.query<Item>('SELECT * FROM drive_source_items WHERE connection_id = ? AND item_id = ?', [change.connectionId, change.itemId])[0];
  if (held && held.kind !== change.kind) throw substratError('conflict', 'source item changed kind');
  const remember = (id: string, status = 'ready') => ctx.sql.exec(
    `INSERT INTO drive_source_items (connection_id, item_id, kind, entity_id, status) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(connection_id, item_id) DO UPDATE SET status = excluded.status`,
    [change.connectionId, change.itemId, change.kind, id, status],
  );
  const now = ctx.now();
  if (change.change === 'delete') {
    if (!held || held.status === 'removed') return { ok: true };
    if (change.kind === 'file') {
      const file = ctx.sql.query<File>('SELECT * FROM drive_files WHERE id = ?', [held.entity_id])[0];
      if (file?.state === 'live') {
        // Trash retains its name, so release the original name without touching siblings.
        let name = `${file.name} (removed ${file.id})`;
        while (ctx.sql.query('SELECT id FROM drive_files WHERE folder_id = ? AND name = ? AND id != ?', [file.folder_id, name, file.id]).length) name += '-';
        ctx.sql.exec("UPDATE drive_files SET name = ?, state = 'trashed', deleted_at = ?, updated_at = ? WHERE id = ?", [name, now, now, file.id]);
        ctx.emit({ type: 'drive.file-trashed', schemaVersion: 1, entity: ref('file', file.id), piiClass: 'none', payload: { id: file.id, folder_id: file.folder_id } });
      }
    }
    // A folder's absence says nothing about its children. Keep the container for held items.
    remember(held.entity_id, 'removed');
    return { ok: true };
  }
  if (change.change === 'content') {
    if (!held || held.kind !== 'file' || held.status === 'removed') throw substratError('conflict', 'source content has no live item');
    const file = ctx.sql.query<File>('SELECT * FROM drive_files WHERE id = ?', [held.entity_id])[0];
    if (!file || file.state !== 'live') throw substratError('conflict', 'source file is not live');
    const attachment = ctx.sql.query<{ entity_id: string; size: number; content_type: string; sha256: string }>(
      "SELECT entity_id, size, content_type, sha256 FROM _substrat_attachments WHERE id = ? AND entity_type = 'file'", [change.attachment.id],
    )[0];
    if (!attachment || attachment.entity_id !== file.id) throw substratError('validation_failed', 'source attachment belongs to another file');
    const current = file.current_version_id ? ctx.sql.query<{ blob_ref: string | null }>('SELECT blob_ref FROM drive_file_versions WHERE id = ?', [file.current_version_id])[0] : undefined;
    if (current?.blob_ref === change.attachment.id) return { ok: true };
    // A connector call can fail after landing bytes, rolling back its cursor. Retrying identical
    // bytes must also be harmless when the attachment upload produced a new id.
    const currentBytes = current?.blob_ref ? ctx.sql.query<{ sha256: string }>('SELECT sha256 FROM _substrat_attachments WHERE id = ?', [current.blob_ref])[0] : undefined;
    if (currentBytes?.sha256 === attachment.sha256) {
      ctx.sql.exec('DELETE FROM drive_source_pending WHERE file_id = ?', [file.id]);
      return { ok: true };
    }
    if ((current?.blob_ref ?? null) !== change.replaces) throw substratError('conflict', 'stale source content: current version changed');
    const id = ulid();
    ctx.sql.exec(`INSERT INTO drive_file_versions (id, file_id, source, blob_ref, mime, size, created_at, created_by)
      VALUES (?, ?, 'blob', ?, ?, ?, ?, ?)`, [id, file.id, change.attachment.id, attachment.content_type, attachment.size, now, ctx.principal]);
    ctx.link(ref('file_version', id), ref('file', file.id));
    ctx.sql.exec('UPDATE drive_files SET current_version_id = ?, updated_at = ? WHERE id = ?', [id, now, file.id]);
    remember(file.id);
    ctx.sql.exec('DELETE FROM drive_source_pending WHERE file_id = ?', [file.id]);
    ctx.emit({ type: 'drive.file-written', schemaVersion: 1, entity: ref('file', file.id), piiClass: 'none', payload: { id: file.id, folder_id: file.folder_id, current_version_id: id } });
    return { ok: true };
  }
  const parts = change.path.split('/');
  if (!parts.length || parts.some((part) => !segment.safeParse(part).success) || parts.at(-1) !== change.name) {
    throw substratError('validation_failed', 'source path must contain valid segments and end in its name');
  }
  const parentPath = parts.slice(0, -1).join('/');
  const parent = ctx.sql.query<Folder>('SELECT * FROM drive_folders WHERE path = ?', [parentPath])[0];
  if (!parent) throw substratError('conflict', 'source parent folder has not landed');
  if (change.kind === 'folder') {
    const prior = held ? ctx.sql.query<Folder>('SELECT * FROM drive_folders WHERE id = ?', [held.entity_id])[0] : undefined;
    const atPath = ctx.sql.query<Folder>('SELECT * FROM drive_folders WHERE path = ?', [change.path])[0];
    if (atPath && atPath.id !== prior?.id) throw substratError('conflict', 'source folder path is occupied');
    const id = prior?.id ?? ulid();
    if (!prior) {
      ctx.sql.exec('INSERT INTO drive_folders (id, parent_id, path, name, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)', [id, parent.id, change.path, change.name, now, ctx.principal]);
      ctx.link(ref('folder', id), ref('folder', parent.id));
      ctx.emit({ type: 'drive.folder-created', schemaVersion: 1, entity: ref('folder', id), piiClass: 'none', payload: { id, parent_id: parent.id, path: change.path } });
    } else if (prior.path !== change.path) {
      if (parent.path === prior.path || parent.path.startsWith(`${prior.path}/`)) throw substratError('conflict', 'source folder cannot move into itself');
      if (prior.parent_id !== parent.id) ctx.relink(ref('folder', id), ref('folder', prior.parent_id), ref('folder', parent.id));
      for (const child of ctx.sql.query<Folder>('SELECT id, path FROM drive_folders')) {
        if (child.path.startsWith(`${prior.path}/`)) ctx.sql.exec('UPDATE drive_folders SET path = ? WHERE id = ?', [change.path + child.path.slice(prior.path.length), child.id]);
      }
      ctx.sql.exec('UPDATE drive_folders SET parent_id = ?, path = ?, name = ? WHERE id = ?', [parent.id, change.path, change.name, id]);
      ctx.emit({ type: 'drive.folder-renamed', schemaVersion: 1, entity: ref('folder', id), piiClass: 'none', payload: { id, parent_id: parent.id, path: change.path, name: change.name } });
    }
    remember(id);
    return { entity: ref('folder', id) };
  }
  let prior = held ? ctx.sql.query<File>('SELECT * FROM drive_files WHERE id = ?', [held.entity_id])[0] : undefined;
  const occupied = ctx.sql.query<File>('SELECT * FROM drive_files WHERE folder_id = ? AND name = ?', [parent.id, change.name])[0];
  if (!prior && occupied?.state === 'live' && ctx.sql.query('SELECT file_id FROM drive_source_pending WHERE file_id = ?', [occupied.id]).length) prior = occupied;
  if (occupied && occupied.id !== prior?.id) throw substratError('conflict', 'source file name is occupied');
  const id = prior?.id ?? ulid();
  if (!prior) {
    ctx.sql.exec("INSERT INTO drive_files (id, folder_id, name, created_at, updated_at, state) VALUES (?, ?, ?, ?, ?, 'live')", [id, parent.id, change.name, now, now]);
    ctx.link(ref('file', id), ref('folder', parent.id));
    ctx.emit({ type: 'drive.file-created', schemaVersion: 1, entity: ref('file', id), piiClass: 'none', payload: { id, folder_id: parent.id } });
  } else if (prior.folder_id !== parent.id || prior.name !== change.name || prior.state !== 'live') {
    if (prior.folder_id !== parent.id) ctx.relink(ref('file', id), ref('folder', prior.folder_id), ref('folder', parent.id));
    ctx.sql.exec("UPDATE drive_files SET folder_id = ?, name = ?, state = 'live', deleted_at = NULL, updated_at = ? WHERE id = ?", [parent.id, change.name, now, id]);
    ctx.emit({ type: 'drive.file-renamed', schemaVersion: 1, entity: ref('file', id), piiClass: 'none', payload: { id, folder_id: parent.id, name: change.name } });
  }
  remember(id, change.content === 'too-large' ? 'too-large' : 'ready');
  return { entity: ref('file', id) };
}
