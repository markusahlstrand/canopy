/**
 * Upload links: how an assistant's agent sends a file's bytes without passing them through the
 * model (`drive_create-upload-link`, then a plain `PUT`).
 *
 * A link is one file, into one folder of one space, under one name, for ten minutes, once. It is
 * stored only as its token's SHA-256 (like app passwords and invites; 256 random bits need nothing
 * slower) and names a SUBJECT, never a principal: redeeming it resolves the login to its principal
 * in the space again, so someone removed in the meantime is refused.
 *
 * The rows live in the tenant's identity DO beside app passwords, created on first use like them.
 */
import type { DirectorySql } from './space-creation';
import type { UploadLink } from './upload.js';

/** Live (unused, unexpired) links one login may hold at once. */
export const MAX_LIVE_UPLOAD_LINKS = 20;

const ensure = (sql: DirectorySql) => {
  sql.exec(`CREATE TABLE IF NOT EXISTS canopy_upload_links (
    token_hash TEXT PRIMARY KEY, sub TEXT NOT NULL, scope_id TEXT NOT NULL, folder_id TEXT NOT NULL, name TEXT NOT NULL,
    also_in TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)`);
  sql.exec('CREATE INDEX IF NOT EXISTS canopy_upload_links_sub ON canopy_upload_links (sub)');
};

/** Store a new link. Spent and expired links are pruned first; too many live ones is `limit`. */
export function createUploadLink(
  sql: DirectorySql,
  link: UploadLink & { tokenHash: string; now: number },
): { ok: true } | { error: 'limit' } {
  ensure(sql);
  sql.exec('DELETE FROM canopy_upload_links WHERE used_at IS NOT NULL OR expires_at <= ?', link.now);
  const [count] = [...sql.exec('SELECT COUNT(*) AS n FROM canopy_upload_links WHERE sub = ?', link.sub)];
  if (Number(count?.n ?? 0) >= MAX_LIVE_UPLOAD_LINKS) return { error: 'limit' };
  sql.exec(
    'INSERT INTO canopy_upload_links (token_hash, sub, scope_id, folder_id, name, also_in, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
    link.tokenHash, link.sub, link.scopeId, link.folderId, link.name, JSON.stringify(link.alsoIn), link.now, link.expiresAt,
  );
  return { ok: true };
}

/** The link a token hash names, if it can still be used at `now`. */
export function peekUploadLink(sql: DirectorySql, tokenHash: string, now: number): UploadLink | null {
  ensure(sql);
  const [row] = [...sql.exec('SELECT * FROM canopy_upload_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', tokenHash, now)];
  if (!row) return null;
  const alsoIn = JSON.parse(String(row.also_in)) as unknown;
  return {
    sub: String(row.sub), scopeId: String(row.scope_id), folderId: String(row.folder_id), name: String(row.name),
    alsoIn: Array.isArray(alsoIn) ? alsoIn.filter((v): v is string => typeof v === 'string') : [],
    expiresAt: Number(row.expires_at),
  };
}

/** Spend a link: true for exactly one caller, while it is unused and unexpired. */
export function claimUploadLink(sql: DirectorySql, tokenHash: string, now: number): boolean {
  ensure(sql);
  if (!peekUploadLink(sql, tokenHash, now)) return false;
  sql.exec('UPDATE canopy_upload_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL', now, tokenHash);
  return true;
}
