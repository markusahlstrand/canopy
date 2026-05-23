import type { Db } from "./db";
import type { Role, User } from "./types";

/**
 * Canonical form of an email for matching: trimmed + lowercased. Invites are
 * bound to an address, so the address an owner types and the one the IdP returns
 * must compare equal regardless of case/whitespace. Applied at every write and
 * lookup; existing rows are normalized by a migration (see schema.ts).
 */
export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

interface UserRow {
  sub: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  updated_at: string;
}
const toUser = (r: UserRow): User => ({
  sub: r.sub,
  email: r.email,
  name: r.name,
  picture: r.picture,
  updatedAt: r.updated_at,
});

/** Upsert the directory entry for a signed-in user (call on every login). */
export async function upsertUser(
  db: Db,
  user: { sub: string; email?: string | null; name?: string | null; picture?: string | null },
): Promise<void> {
  await db.run(
    `INSERT INTO users (sub, email, name, picture, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(sub) DO UPDATE SET email = excluded.email, name = excluded.name,
       picture = excluded.picture, updated_at = excluded.updated_at`,
    [user.sub, user.email ? normalizeEmail(user.email) : null, user.name ?? null, user.picture ?? null, new Date().toISOString()],
  );
}

/**
 * Backfill a directory row from session claims when one is missing (idempotent,
 * cheap — a no-op once the row exists). Unlike {@link upsertUser} it never
 * overwrites an existing row: login owns profile refresh, this just ensures a
 * long-lived session (or a reset dev DB) still has a directory entry so the
 * member/sharing UI can show a name & email instead of the raw sub.
 */
export async function ensureUser(
  db: Db,
  user: { sub: string; email?: string | null; name?: string | null; picture?: string | null },
): Promise<void> {
  await db.run(
    `INSERT OR IGNORE INTO users (sub, email, name, picture, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [user.sub, user.email ? normalizeEmail(user.email) : null, user.name ?? null, user.picture ?? null, new Date().toISOString()],
  );
}

/** Resolve an email to a known user (for turning a share-by-email into a user grant). */
export async function findUserByEmail(db: Db, email: string): Promise<User | null> {
  const row = await db.first<UserRow>("SELECT * FROM users WHERE email = ?", [normalizeEmail(email)]);
  return row ? toUser(row) : null;
}

export async function getUser(db: Db, sub: string): Promise<User | null> {
  const row = await db.first<UserRow>("SELECT * FROM users WHERE sub = ?", [sub]);
  return row ? toUser(row) : null;
}

/**
 * Convert any pending `email:<addr>` grants into `user:<sub>` grants now that
 * we know the user's sub. Called on login so files invited by email show up.
 */
export async function resolveInvites(db: Db, sub: string, email?: string | null): Promise<void> {
  const addr = normalizeEmail(email);
  if (!addr) return;
  await db.run(
    `UPDATE OR IGNORE relation_tuples SET subject_type = 'user', subject_id = ?
       WHERE subject_type = 'email' AND subject_id = ?`,
    [sub, addr],
  );
  await db.run("DELETE FROM relation_tuples WHERE subject_type = 'email' AND subject_id = ?", [addr]);
}

/** A space the given email has been invited to but not yet claimed (for an invites banner). */
export interface PendingSpaceInvite {
  spaceId: string;
  spaceName: string;
  role: Role;
}

/**
 * Pending space invites awaiting a user with this (normalized) email — the
 * `email:` grants {@link resolveInvites} would convert on a verified login.
 * Lets an already-signed-in user discover invites created after their last login.
 */
export async function pendingSpaceInvites(db: Db, email?: string | null): Promise<PendingSpaceInvite[]> {
  const addr = normalizeEmail(email);
  if (!addr) return [];
  const rows = await db.all<{ space_id: string; name: string; relation: string }>(
    `SELECT t.object_id AS space_id, s.name AS name, t.relation AS relation
       FROM relation_tuples t JOIN spaces s ON s.id = t.object_id
       WHERE t.object_type = 'space' AND t.subject_type = 'email' AND t.subject_id = ?
         AND t.relation IN ('owner','editor','viewer')`,
    [addr],
  );
  return rows.map((r) => ({ spaceId: r.space_id, spaceName: r.name, role: r.relation as Role }));
}
