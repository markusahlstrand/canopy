import { mailInChange, substratError, z } from '@substrat-run/contracts';
import { assertAllowed, ulid, type OperationContext } from '@substrat-run/kernel';
import { DRIVE_PERM } from './manifest.js';
import { ROOT_FOLDER_ID } from './migrations.js';

/**
 * Mail forwarded to a space's address (#357), landed by the platform's mail-in connector
 * (substrat#2611) one change at a time, as the address's own connection:
 *
 *   Mail/2026-10-26 Invoice from Acme/
 *     message.eml        ← the original, when the platform carries it (`raw`)
 *     invoice-1234.pdf   ← each attachment as an ordinary file
 *
 * Mail-in stores every byte of a message on the ONE entity the `message` change answers. That
 * entity is the message's folder, which is why `folder` is an attachment target whose write key is
 * `drive:receive-mail`: nobody else can put bytes on a folder. Each file here then names bytes that
 * belong to its folder, not to itself, and reads stay gated by `drive:read` on that folder.
 *
 * Delivery is at least once. Everything is keyed on the platform's `messageId` (and the part), so a
 * change that arrives twice answers what it answered the first time and writes nothing new.
 */

/**
 * The `raw` change: the original RFC 822 bytes, stored on the answered entity. The platform sends
 * it only to an operation that answered `{ raw: true }`. Declared here until the contracts release
 * that carries it; the shape is the same.
 */
const rawChange = z.object({
  change: z.literal('raw'),
  connectionId: z.string(),
  messageId: z.string().min(1),
  attachment: z.object({ id: z.string(), filename: z.string(), contentType: z.string(), size: z.number().int().nonnegative(), sha256: z.string() }),
});
export const driveMailChange = z.union([mailInChange, rawChange]);
export type DriveMailChange = z.infer<typeof driveMailChange>;

export const MAIL_FOLDER = 'Mail';
export const RAW_FILENAME = 'message.eml';

type Ref = { entityType: string; entityId: string };
const ref = (entityType: string, entityId: string): Ref => ({ entityType, entityId });
type Message = { message_id: string; folder_id: string };
type Folder = { id: string; path: string };

/** A file or folder name from untrusted text: one segment, printable, bounded. */
export function mailName(text: string, fallback: string, max = 120): string {
  const cleaned = text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[/\\]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+$/, '');
  const name = (cleaned || fallback).slice(0, max).trim();
  return name || fallback;
}

/** `invoice.pdf` → `invoice (2).pdf`, keeping the extension. */
function numbered(name: string, n: number): string {
  if (n === 1) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

function folderAt(ctx: OperationContext, path: string): Folder | undefined {
  return ctx.sql.query<Folder>('SELECT id, path FROM drive_folders WHERE path = ?', [path])[0];
}

function createFolder(ctx: OperationContext, parentId: string, parentPath: string, name: string): Folder {
  const id = ulid();
  const path = parentPath ? `${parentPath}/${name}` : name;
  ctx.sql.exec('INSERT INTO drive_folders (id, parent_id, path, name, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)', [id, parentId, path, name, ctx.now(), ctx.principal]);
  ctx.link(ref('folder', id), ref('folder', parentId));
  ctx.emit({ type: 'drive.folder-created', schemaVersion: 1, entity: ref('folder', id), piiClass: 'none', payload: { id, parent_id: parentId, path } });
  return { id, path };
}

/** A name in `folderId` no live or trashed file holds yet. */
function freeFileName(ctx: OperationContext, folderId: string, wanted: string): string {
  for (let n = 1; ; n++) {
    const name = numbered(wanted, n);
    if (!ctx.sql.query('SELECT id FROM drive_files WHERE folder_id = ? AND name = ?', [folderId, name]).length) return name;
  }
}

/** The message's folder, gated by its own bytes: an attachment id must belong to it. */
function landedBytes(ctx: OperationContext, message: Message, attachmentId: string) {
  const row = ctx.sql.query<{ entity_type: string; entity_id: string; content_type: string; size: number }>(
    'SELECT entity_type, entity_id, content_type, size FROM _substrat_attachments WHERE id = ?', [attachmentId],
  )[0];
  if (!row || row.entity_type !== 'folder' || row.entity_id !== message.folder_id) {
    throw substratError('validation_failed', 'mail bytes must be stored on the message folder');
  }
  return row;
}

/** One part of a message becomes one file, once. */
function landPart(ctx: OperationContext, message: Message, part: string, filename: string, attachmentId: string): { ok: true } {
  if (ctx.sql.query('SELECT file_id FROM drive_mail_parts WHERE message_id = ? AND part = ?', [message.message_id, part]).length) return { ok: true };
  const bytes = landedBytes(ctx, message, attachmentId);
  const now = ctx.now();
  const fileId = ulid();
  const name = freeFileName(ctx, message.folder_id, mailName(filename, part === 'raw' ? RAW_FILENAME : `attachment-${Number(part) + 1}`));
  ctx.sql.exec("INSERT INTO drive_files (id, folder_id, name, created_at, updated_at, state) VALUES (?, ?, ?, ?, ?, 'live')", [fileId, message.folder_id, name, now, now]);
  ctx.link(ref('file', fileId), ref('folder', message.folder_id));
  const versionId = ulid();
  ctx.sql.exec(`INSERT INTO drive_file_versions (id, file_id, source, blob_ref, mime, size, created_at, created_by)
    VALUES (?, ?, 'blob', ?, ?, ?, ?, ?)`, [versionId, fileId, attachmentId, bytes.content_type, bytes.size, now, ctx.principal]);
  ctx.link(ref('file_version', versionId), ref('file', fileId));
  ctx.sql.exec('UPDATE drive_files SET current_version_id = ? WHERE id = ?', [versionId, fileId]);
  ctx.sql.exec('INSERT INTO drive_mail_parts (message_id, part, file_id) VALUES (?, ?, ?)', [message.message_id, part, fileId]);
  ctx.emit({ type: 'drive.file-created', schemaVersion: 1, entity: ref('file', fileId), piiClass: 'none', payload: { id: fileId, folder_id: message.folder_id } });
  ctx.emit({ type: 'drive.file-written', schemaVersion: 1, entity: ref('file', fileId), piiClass: 'none', payload: { id: fileId, folder_id: message.folder_id, current_version_id: versionId } });
  return { ok: true };
}

/** `2026-10-26 Invoice from Acme`, from the message's date (or its arrival) and subject. */
function messageFolderName(date: string | null, receivedAt: string, subject: string | null): string {
  const day = (date ?? receivedAt).slice(0, 10);
  return mailName(`${day} ${subject?.trim() || '(no subject)'}`, day, 100);
}

export async function landMailChange(ctx: OperationContext, input: unknown): Promise<{ entity?: Ref; raw?: boolean; ok?: boolean }> {
  assertAllowed(await ctx.check(DRIVE_PERM.receiveMail));
  const change = driveMailChange.parse(input);
  const held = ctx.sql.query<Message>('SELECT message_id, folder_id FROM drive_mail_messages WHERE message_id = ?', [change.messageId])[0];

  if (change.change === 'message') {
    // A redelivery answers the same folder, so the platform's bytes land where the first answer said.
    if (held) return { entity: ref('folder', held.folder_id), raw: true };
    const root = folderAt(ctx, '');
    if (!root || root.id !== ROOT_FOLDER_ID) throw substratError('conflict', 'the space has no root folder');
    const mail = folderAt(ctx, MAIL_FOLDER) ?? createFolder(ctx, root.id, '', MAIL_FOLDER);
    const wanted = messageFolderName(change.date, change.receivedAt, change.subject);
    let name = wanted;
    for (let n = 2; folderAt(ctx, `${mail.path}/${name}`); n++) name = `${wanted} (${n})`;
    const folder = createFolder(ctx, mail.id, mail.path, name);
    // No sender, subject or body here: those live in the message's own files (message.eml), where
    // erasure and permissions already reach. This row is only the delivery's identity.
    ctx.sql.exec(
      'INSERT INTO drive_mail_messages (message_id, connection_id, folder_id, received_at, attachments) VALUES (?, ?, ?, ?, ?)',
      [change.messageId, change.connectionId, folder.id, change.receivedAt, change.attachments.filter((a) => a.lands).length],
    );
    return { entity: ref('folder', folder.id), raw: true };
  }

  // Bytes only ever follow an answered `message`; one without it is the platform out of order.
  if (!held) throw substratError('conflict', 'mail bytes arrived before their message');
  if (change.change === 'raw') return landPart(ctx, held, 'raw', RAW_FILENAME, change.attachment.id);
  return landPart(ctx, held, String(change.index), change.attachment.filename, change.attachment.id);
}

/** What a space's mail looks like from settings: counts, never who it came from. */
export function mailSummary(ctx: OperationContext): { messages: number; lastReceivedAt: string | null } {
  const row = ctx.sql.query<{ n: number; last: string | null }>('SELECT COUNT(*) AS n, MAX(received_at) AS last FROM drive_mail_messages')[0];
  return { messages: row?.n ?? 0, lastReceivedAt: row?.last ?? null };
}
