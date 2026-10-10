/**
 * App passwords: how a WebDAV client signs in (#299).
 *
 * Finder and Explorer speak HTTP Basic and cannot run an OIDC login, so a signed-in person
 * mints a password for each client here and pastes it into the mount dialog. It is shown
 * once and stored only as a SHA-256 hash, like invite and owner-claim tokens. The secret is
 * 256 random bits, so a fast hash is enough: there is nothing to brute-force.
 *
 * A password names a SUBJECT (the login), never a principal. A principal is a fact about one
 * space, and the same login is a different principal in each. Every WebDAV request resolves
 * the subject to a principal per space, through the same `identity` rows a browser session
 * uses. Removing someone from a space unbinds those rows, so their password stops reaching
 * that space with no extra bookkeeping here.
 *
 * The rows live in the tenant's identity DO, beside the other per-login facts, because a
 * password belongs to the login, not to any one space (kernel-design §7.3).
 */
import type { DirectorySql } from './space-creation';

/** Enough for one per device, few enough that a forgotten one is noticed. */
export const MAX_APP_PASSWORDS = 20;
export const MAX_APP_PASSWORD_NAME = 60;
/** `last_used_at` is for the "last used" column, so a write per request would be waste. */
const LAST_USED_RESOLUTION_MS = 60_000;

export interface AppPassword { id: string; name: string; created_at: number; last_used_at: number | null }

const ensure = (sql: DirectorySql) => {
  sql.exec(`CREATE TABLE IF NOT EXISTS canopy_app_passwords (
    id TEXT PRIMARY KEY, sub TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL, last_used_at INTEGER)`);
  sql.exec('CREATE INDEX IF NOT EXISTS canopy_app_passwords_sub ON canopy_app_passwords (sub)');
};

export function createAppPassword(
  sql: DirectorySql,
  row: { id: string; sub: string; name: string; tokenHash: string; now: number },
): AppPassword | { error: 'limit' } {
  ensure(sql);
  const [count] = [...sql.exec('SELECT COUNT(*) AS n FROM canopy_app_passwords WHERE sub = ?', row.sub)];
  if (Number(count?.n ?? 0) >= MAX_APP_PASSWORDS) return { error: 'limit' };
  sql.exec(
    'INSERT INTO canopy_app_passwords (id, sub, name, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, NULL)',
    row.id, row.sub, row.name, row.tokenHash, row.now,
  );
  return { id: row.id, name: row.name, created_at: row.now, last_used_at: null };
}

export function listAppPasswords(sql: DirectorySql, sub: string): AppPassword[] {
  ensure(sql);
  return [...sql.exec(
    'SELECT id, name, created_at, last_used_at FROM canopy_app_passwords WHERE sub = ? ORDER BY created_at DESC, id DESC', sub,
  )] as unknown as AppPassword[];
}

/** Scoped to the caller's own subject, so one login cannot revoke another's password. */
export function revokeAppPassword(sql: DirectorySql, sub: string, id: string): boolean {
  ensure(sql);
  const found = [...sql.exec('SELECT 1 FROM canopy_app_passwords WHERE id = ? AND sub = ?', id, sub)].length > 0;
  if (found) sql.exec('DELETE FROM canopy_app_passwords WHERE id = ? AND sub = ?', id, sub);
  return found;
}

/** The subject a presented password belongs to, or null. */
export function verifyAppPassword(sql: DirectorySql, tokenHash: string, now: number): string | null {
  ensure(sql);
  const [row] = [...sql.exec('SELECT id, sub, last_used_at FROM canopy_app_passwords WHERE token_hash = ?', tokenHash)];
  if (!row) return null;
  const last = row.last_used_at === null ? null : Number(row.last_used_at);
  if (last === null || now - last >= LAST_USED_RESOLUTION_MS) {
    sql.exec('UPDATE canopy_app_passwords SET last_used_at = ? WHERE id = ?', now, String(row.id));
  }
  return String(row.sub);
}

/** A fresh secret: 256 random bits, base64url, with a prefix that makes a leaked one recognizable. */
export function mintAppPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `canopy_${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/** Clean a client label: trimmed, single-line, bounded. Null when nothing usable is left. */
export function appPasswordName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return name && name.length <= MAX_APP_PASSWORD_NAME ? name : null;
}
