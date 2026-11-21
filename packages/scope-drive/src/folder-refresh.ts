/**
 * Check a connected space's folder against its source when someone opens it.
 *
 * The drive cannot reach a source itself: the platform holds the credential and calls the
 * connector. So a check is a REQUEST recorded here, which the worker follows with a poll of the
 * source (`syncConnections`), and which a connector that can read one folder takes up at the start
 * of its sweep (`drive/source-folder-requests`) and answers (`drive/source-folder-checked`). A
 * connector that cannot still has its ordinary pass run by that poll, and the worker records how
 * the poll went (`drive/settle-folder-refresh`).
 *
 * Asking is cheap and safe to repeat, because this decides whether anything happens:
 *  - `fresh`: the folder was checked within the throttle (a minute by default), so nothing is
 *    asked of the source. A forced check (the person pressed refresh) skips this.
 *  - `joined`: a check of this folder is already under way; the caller waits for that one.
 *  - `start`: the request is recorded, and the worker polls the source.
 *
 * A request nobody took up does not wait forever: after {@link UNTAKEN_RETRY_MS} (the platform's
 * own once-a-minute floor on polling a binding) the next ask starts it again, and a taken one is
 * given {@link TAKEN_RETRY_MS} to finish. Each answer emits `drive.folder-checked` on the folder,
 * so people looking at it get a live frame and re-read it.
 */
import { substratError, type HandlerInput, type HandlerOutput } from '@substrat-run/contracts';
import { assertAllowed, type OperationContext, type OperationHandler } from '@substrat-run/kernel';
import { DRIVE_PERM } from './manifest.js';
import type { driveOperations, FolderRefresh } from '../spec/model.js';

/** How long a check stays fresh when the worker names no throttle of its own. */
export const DEFAULT_REFRESH_THROTTLE_MS = 60_000;
/** The least a configured throttle can be: a source is never asked about one folder more often. */
export const MIN_REFRESH_THROTTLE_MS = 10_000;
/** A request no connector took: asked again after this (the platform polls a binding once a minute). */
export const UNTAKEN_RETRY_MS = 60_000;
/** A request a connector took but never answered (its call died): asked again after this. */
export const TAKEN_RETRY_MS = 3 * 60_000;
/** A request older than this is no longer handed to a connector: whoever asked has moved on. */
export const REQUEST_EXPIRES_MS = 10 * 60_000;

type Row = { folder_id: string; pending: number; requested_at: string | null; taken_at: string | null; checked_at: string | null; error: string | null; changes: number };
type Ops = typeof driveOperations;
type RefreshOp = 'drive/request-folder-refresh' | 'drive/settle-folder-refresh' | 'drive/source-folder-requests' | 'drive/source-folder-checked';

const folderRef = (id: string) => ({ entityType: 'folder', entityId: id }) as const;
const ms = (iso: string | null) => (iso ? Date.parse(iso) : Number.NaN);
const hasSource = (ctx: OperationContext) =>
  ctx.sql.query<{ provider: string }>('SELECT provider FROM drive_source WHERE id = 1')[0]?.provider ?? null;

function folderPath(ctx: OperationContext, folderId: string): string {
  const folder = ctx.sql.query<{ path: string }>('SELECT path FROM drive_folders WHERE id = ?', [folderId])[0];
  if (!folder) throw substratError('not_found', 'no such folder');
  return folder.path;
}
const rowOf = (ctx: OperationContext, folderId: string) =>
  ctx.sql.query<Row>('SELECT * FROM drive_source_refresh WHERE folder_id = ?', [folderId])[0];

/** A check asked for and not answered since: an explicit flag, never two timestamps compared. */
const asked = (row: Row | undefined): row is Row & { requested_at: string } => row?.pending === 1 && !!row.requested_at;

/** Asked, and still worth waiting for: neither forgotten by every connector nor abandoned by one. */
function underWay(row: Row | undefined, now: number): boolean {
  if (!asked(row)) return false;
  return row.taken_at ? now - ms(row.taken_at) < TAKEN_RETRY_MS : now - ms(row.requested_at) < UNTAKEN_RETRY_MS;
}

/** The folder's state as a person reads it. */
export function refreshOf(ctx: OperationContext, folderId: string, path: string, now = ms(ctx.now())): FolderRefresh {
  const row = rowOf(ctx, folderId);
  const state = underWay(row, now) ? 'checking' : row?.checked_at ? (row.error ? 'failed' : 'checked') : 'unchecked';
  return { folderId, path, state, checkedAt: row?.checked_at ?? null, error: row?.error ?? null, changes: row?.changes ?? 0 };
}

/** Record a check's end on the folder, and tell whoever is looking at it. */
function finish(ctx: OperationContext, folderId: string, error: string | null, changes: number) {
  ctx.sql.exec(
    `INSERT INTO drive_source_refresh (folder_id, pending, checked_at, error, changes) VALUES (?, 0, ?, ?, ?)
     ON CONFLICT(folder_id) DO UPDATE SET pending = 0, checked_at = excluded.checked_at, error = excluded.error, changes = excluded.changes`,
    [folderId, ctx.now(), error, changes],
  );
  ctx.emit({ type: 'drive.folder-checked', schemaVersion: 1, entity: folderRef(folderId), piiClass: 'none', payload: { folderId } });
}

export const folderRefreshHandlers = {
  'drive/request-folder-refresh': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read, folderRef(input.folderId)));
    const path = folderPath(ctx, input.folderId);
    const provider = hasSource(ctx);
    if (!provider) return { decision: 'unsupported' as const, provider: null, refresh: null };
    const now = ms(ctx.now());
    const throttle = Math.max(MIN_REFRESH_THROTTLE_MS, input.throttleMs ?? DEFAULT_REFRESH_THROTTLE_MS);
    const row = rowOf(ctx, input.folderId);
    if (underWay(row, now)) return { decision: 'joined' as const, provider, refresh: refreshOf(ctx, input.folderId, path, now) };
    // A failed check is fresh too: a source that is down is not asked again on every open.
    if (!input.force && row?.checked_at && now - ms(row.checked_at) < throttle) {
      return { decision: 'fresh' as const, provider, refresh: refreshOf(ctx, input.folderId, path, now) };
    }
    ctx.sql.exec(
      `INSERT INTO drive_source_refresh (folder_id, pending, requested_at) VALUES (?, 1, ?)
       ON CONFLICT(folder_id) DO UPDATE SET pending = 1, requested_at = excluded.requested_at, taken_at = NULL`,
      [input.folderId, ctx.now()],
    );
    return { decision: 'start' as const, provider, refresh: refreshOf(ctx, input.folderId, path, now) };
  },

  'drive/settle-folder-refresh': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read, folderRef(input.folderId)));
    const path = folderPath(ctx, input.folderId);
    const row = rowOf(ctx, input.folderId);
    // Only a request still open: a connector that answered for the folder said more than a poll can.
    // A poll that succeeded says nothing about a folder a connector took and has not answered yet.
    if (asked(row) && (input.outcome === 'failed' || !row.taken_at)) {
      finish(ctx, input.folderId, input.outcome === 'failed' ? (input.error ?? 'The source gave no reason.') : null, input.changes ?? 0);
    }
    return { folderId: input.folderId, refresh: refreshOf(ctx, input.folderId, path) };
  },

  'drive/source-folder-requests': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.landSource));
    const now = ms(ctx.now());
    const rows = ctx.sql.query<Row & { path: string }>(
      `SELECT r.*, f.path FROM drive_source_refresh r JOIN drive_folders f ON f.id = r.folder_id
        WHERE r.pending = 1 AND r.requested_at IS NOT NULL
        ORDER BY r.requested_at`,
    );
    const due = rows
      .filter((r) => now - ms(r.requested_at) < REQUEST_EXPIRES_MS && (!r.taken_at || now - ms(r.taken_at) >= TAKEN_RETRY_MS))
      .slice(0, input.limit);
    for (const r of due) ctx.sql.exec('UPDATE drive_source_refresh SET taken_at = ? WHERE folder_id = ?', [ctx.now(), r.folder_id]);
    return { folders: due.map((r) => ({ folderId: r.folder_id, path: r.path })) };
  },

  'drive/source-folder-checked': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.landSource));
    const folder = ctx.sql.query<{ path: string }>('SELECT path FROM drive_folders WHERE id = ?', [input.folderId])[0];
    // The folder went while it was checked (the source removed it): nothing left to describe.
    if (!folder) return { folderId: input.folderId, refresh: null };
    // Stopped by a budget with more to read: back in the queue for the next call to take, still
    // `checking` to whoever looks. What it landed already shows; the rest is skipped as unchanged.
    if (input.requeue && !input.error) {
      if (asked(rowOf(ctx, input.folderId))) ctx.sql.exec('UPDATE drive_source_refresh SET taken_at = NULL WHERE folder_id = ?', [input.folderId]);
      return { folderId: input.folderId, refresh: refreshOf(ctx, input.folderId, folder.path) };
    }
    finish(ctx, input.folderId, input.error ?? null, input.changes);
    return { folderId: input.folderId, refresh: refreshOf(ctx, input.folderId, folder.path) };
  },
} satisfies {
  [K in RefreshOp]: OperationHandler<HandlerInput<Ops[K]>, HandlerOutput<Ops[K]>>;
};
