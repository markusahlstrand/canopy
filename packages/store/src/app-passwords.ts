import type { Db } from "./db";
import { sha256hex } from "./hash";

/**
 * App passwords: per-device tokens for Basic-auth clients (e.g. WebDAV in
 * Finder) that can't do an OIDC browser flow. The plaintext token is shown
 * once at creation; only its SHA-256 is stored.
 */

export interface AppPassword {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function createAppPassword(db: Db, userSub: string, name: string): Promise<{ id: string; token: string }> {
  const id = crypto.randomUUID();
  const token = randomToken();
  const tokenHash = await sha256hex(new TextEncoder().encode(token));
  await db.run(
    "INSERT INTO app_passwords (id, user_sub, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    [id, userSub, name || "Device", tokenHash, new Date().toISOString()],
  );
  return { id, token };
}

/** Resolve a token to its owner's sub (and bump last_used_at), or null. */
export async function verifyAppPassword(db: Db, token: string): Promise<string | null> {
  if (!token) return null;
  const tokenHash = await sha256hex(new TextEncoder().encode(token));
  const row = await db.first<{ id: string; user_sub: string }>(
    "SELECT id, user_sub FROM app_passwords WHERE token_hash = ?",
    [tokenHash],
  );
  if (!row) return null;
  await db.run("UPDATE app_passwords SET last_used_at = ? WHERE id = ?", [new Date().toISOString(), row.id]);
  return row.user_sub;
}

export async function listAppPasswords(db: Db, userSub: string): Promise<AppPassword[]> {
  const rows = await db.all<{ id: string; name: string; created_at: string; last_used_at: string | null }>(
    "SELECT id, name, created_at, last_used_at FROM app_passwords WHERE user_sub = ? ORDER BY created_at DESC",
    [userSub],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
}

export async function deleteAppPassword(db: Db, userSub: string, id: string): Promise<void> {
  await db.run("DELETE FROM app_passwords WHERE id = ? AND user_sub = ?", [id, userSub]);
}
