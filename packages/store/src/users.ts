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

/**
 * People the user is "connected" to — for the share-with picker, so they can
 * pick a known contact instead of retyping an address. Two sources, unioned:
 *   • **via a place** — co-members of any space the user belongs to;
 *   • **via shared docs** — owners of files shared *with* the user, and anyone
 *     the user has shared their own files with (the file-grant graph, both ways).
 * `spaceIds` is the user's effective space set (see authz `memberSpaceIds`),
 * passed in by the caller to keep this module free of the authz recursion.
 * Excludes the user themselves; `q` filters by name/email substring.
 */
export async function connectedUsers(
  db: Db,
  userSub: string,
  spaceIds: string[],
  q?: string,
  limit = 20,
): Promise<User[]> {
  const subs = new Set<string>();

  // via a place: anyone who shares one of the user's spaces.
  if (spaceIds.length > 0) {
    const ph = spaceIds.map(() => "?").join(",");
    const rows = await db.all<{ subject_id: string }>(
      `SELECT DISTINCT subject_id FROM relation_tuples
         WHERE object_type = 'space' AND subject_type = 'user'
           AND relation IN ('owner','editor','viewer') AND object_id IN (${ph})`,
      spaceIds,
    );
    for (const r of rows) subs.add(r.subject_id);
  }

  // via shared docs: files the user owns or has a direct grant on → the file's
  // owner plus everyone else granted on it.
  const fileRows = await db.all<{ subject_id: string }>(
    `WITH my_files(id, owner_id) AS (
        SELECT id, owner_id FROM files WHERE owner_id = ? AND deleted_at IS NULL
        UNION
        SELECT f.id, f.owner_id FROM files f
          JOIN relation_tuples t ON t.object_type = 'file' AND t.object_id = f.id
          WHERE t.subject_type = 'user' AND t.subject_id = ? AND f.deleted_at IS NULL
     )
     SELECT DISTINCT owner_id AS subject_id FROM my_files
     UNION
     SELECT DISTINCT t.subject_id FROM relation_tuples t
       JOIN my_files mf ON mf.id = t.object_id
       WHERE t.object_type = 'file' AND t.subject_type = 'user'
         AND t.relation IN ('owner','editor','viewer')`,
    [userSub, userSub],
  );
  for (const r of fileRows) subs.add(r.subject_id);

  subs.delete(userSub);
  if (subs.size === 0) return [];

  const ids = [...subs];
  const params: unknown[] = [...ids];
  let where = `sub IN (${ids.map(() => "?").join(",")})`;
  const term = (q ?? "").trim().toLowerCase();
  if (term) {
    where += " AND (lower(name) LIKE ? OR lower(email) LIKE ?)";
    params.push(`%${term}%`, `%${term}%`);
  }
  params.push(limit);
  const rows = await db.all<UserRow>(
    `SELECT * FROM users WHERE ${where} ORDER BY name IS NULL, name, email LIMIT ?`,
    params,
  );
  return rows.map(toUser);
}
