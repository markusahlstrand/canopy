import type { Db } from "./db";
import type { Role } from "./types";
import { normalizeEmail } from "./users";

/**
 * Relation-tuple (Zanzibar-lite) access control, evaluated with recursive SQL.
 *
 * A tuple is `object#relation@subject`, where the subject is a user, an email
 * (a pending invite), or a *userset* — a space's members (`space:<id>#member`).
 * Rewrite rules, baked into the check below rather than a config language:
 *   • role hierarchy: owner ⊇ editor ⊇ viewer (compared by rank);
 *   • a space's members get that space's role on its files (the `space` relation
 *     on a file points at its containing space — "tuple-to-userset");
 *   • nested groups: a member of space S is a member of any space that grants
 *     membership to `S#member` (recursive).
 *
 * `check` (does U have role R on object O?) is one recursive query; we keep the
 * tuples in a single store precisely so it never fans out across databases.
 */

export type ObjectType = "file" | "space" | "folder";
export type SubjectType = "user" | "space" | "email";

// A folder isn't a row with a stable id (it's a virtual path within a space), so
// a folder tuple's object_id encodes `${spaceId}<US>${path}`. A grant on a folder
// covers that folder and everything under it — so access to a path is checked
// against grants on the path itself and each of its ancestors.
const FOLDER_SEP = "\u001f";
export const folderObjectId = (spaceId: string, path: string): string => `${spaceId}${FOLDER_SEP}${path}`;
export function parseFolderObjectId(objectId: string): { spaceId: string; path: string } | null {
  const i = objectId.indexOf(FOLDER_SEP);
  return i < 0 ? null : { spaceId: objectId.slice(0, i), path: objectId.slice(i + 1) };
}
/** A path's folder ancestors, innermost-out, *inclusive*, excluding the space root. e.g. "A/B/C" → ["A","A/B","A/B/C"]. */
export function ancestorFolderPaths(path: string): string[] {
  const segs = path.split("/").filter(Boolean);
  return segs.map((_, i) => segs.slice(0, i + 1).join("/"));
}

/** The higher of two (possibly null) roles. */
export function maxRole(a: Role | null, b: Role | null): Role | null {
  return rankToRole(Math.max(a ? ROLE_RANK[a] : 0, b ? ROLE_RANK[b] : 0));
}

export interface Tuple {
  objectType: ObjectType;
  objectId: string;
  relation: string; // 'owner' | 'editor' | 'viewer' | 'space'
  subjectType: SubjectType;
  subjectId: string;
  /** '' for a direct subject; 'member' for a space userset. */
  subjectRelation?: string;
}

export const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
export function rankToRole(rank: number): Role | null {
  return rank >= 3 ? "owner" : rank >= 2 ? "editor" : rank >= 1 ? "viewer" : null;
}

// SQL that maps a `relation` column to a numeric rank.
const RANK = "CASE relation WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END";

// (space_id, rank) the user effectively holds — direct grants, then nested groups.
// Param order: [userSub]
const USER_SPACES = `
WITH RECURSIVE user_spaces(space_id, rank) AS (
  SELECT object_id, ${RANK}
    FROM relation_tuples
    WHERE object_type = 'space' AND subject_type = 'user' AND subject_id = ? AND subject_relation = ''
  UNION
  SELECT t.object_id, CASE t.relation WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END
    FROM relation_tuples t
    JOIN user_spaces us ON t.subject_type = 'space' AND t.subject_id = us.space_id AND t.subject_relation = 'member'
    WHERE t.object_type = 'space'
)`;

export async function writeTuple(db: Db, t: Tuple): Promise<void> {
  await db.run(
    `INSERT OR IGNORE INTO relation_tuples
       (object_type, object_id, relation, subject_type, subject_id, subject_relation)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [t.objectType, t.objectId, t.relation, t.subjectType, t.subjectId, t.subjectRelation ?? ""],
  );
}

export async function deleteTuple(db: Db, t: Tuple): Promise<void> {
  await db.run(
    `DELETE FROM relation_tuples
       WHERE object_type = ? AND object_id = ? AND relation = ?
         AND subject_type = ? AND subject_id = ? AND subject_relation = ?`,
    [t.objectType, t.objectId, t.relation, t.subjectType, t.subjectId, t.subjectRelation ?? ""],
  );
}

/** Grants on `file:<id>` (any relation) → for a Share dialog. */
export async function fileGrants(db: Db, fileId: string): Promise<Tuple[]> {
  const rows = await db.all<{
    subject_type: SubjectType;
    subject_id: string;
    subject_relation: string;
    relation: string;
  }>(
    `SELECT relation, subject_type, subject_id, subject_relation FROM relation_tuples
       WHERE object_type = 'file' AND object_id = ? AND relation IN ('owner','editor','viewer')`,
    [fileId],
  );
  return rows.map((r) => ({
    objectType: "file",
    objectId: fileId,
    relation: r.relation,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    subjectRelation: r.subject_relation,
  }));
}

/** A file grant enriched with directory info for its subject (for the Share dialog). */
export interface GrantDetail extends Tuple {
  /** Display name for a `user` subject, else null. */
  name: string | null;
  /** Email for a `user` (from the directory) or `email` (the address itself) subject, else null. */
  email: string | null;
  picture: string | null;
}

/**
 * Grants on `file:<id>` with the subject's directory info joined in, so a
 * `user:` grant (e.g. an email share that resolved to a known account) shows a
 * name/email instead of the raw OIDC sub. `space:` subjects are labelled by the
 * caller from their space list.
 */
export async function fileGrantsDetailed(db: Db, fileId: string): Promise<GrantDetail[]> {
  const rows = await db.all<{
    relation: string;
    subject_type: SubjectType;
    subject_id: string;
    subject_relation: string;
    name: string | null;
    email: string | null;
    picture: string | null;
  }>(
    `SELECT t.relation, t.subject_type, t.subject_id, t.subject_relation,
            u.name AS name, u.email AS email, u.picture AS picture
       FROM relation_tuples t
       LEFT JOIN users u ON t.subject_type = 'user' AND u.sub = t.subject_id
       WHERE t.object_type = 'file' AND t.object_id = ? AND t.relation IN ('owner','editor','viewer')`,
    [fileId],
  );
  return rows.map((r) => ({
    objectType: "file" as const,
    objectId: fileId,
    relation: r.relation,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    subjectRelation: r.subject_relation,
    name: r.name,
    email: r.subject_type === "email" ? r.subject_id : r.email,
    picture: r.picture,
  }));
}

/** The user's effective role on a space (via membership + nested groups), or null. */
export async function spaceRole(db: Db, spaceId: string, userSub: string): Promise<Role | null> {
  const row = await db.first<{ rank: number | null }>(
    `${USER_SPACES} SELECT MAX(rank) AS rank FROM user_spaces WHERE space_id = ?`,
    [userSub, spaceId],
  );
  return rankToRole(row?.rank ?? 0);
}

/** The set of space ids the user can see (for "my spaces" listings). */
export async function memberSpaceIds(db: Db, userSub: string): Promise<string[]> {
  const rows = await db.all<{ space_id: string }>(
    `${USER_SPACES} SELECT DISTINCT space_id FROM user_spaces`,
    [userSub],
  );
  return rows.map((r) => r.space_id);
}

/** The user's effective role on a file — direct, via a space grant, via the file's space, or by email. */
export async function fileRole(db: Db, fileId: string, userSub: string, email = ""): Promise<Role | null> {
  const addr = normalizeEmail(email);
  const row = await db.first<{ rank: number | null }>(
    `${USER_SPACES}
     SELECT MAX(rank) AS rank FROM (
       SELECT ${RANK} AS rank FROM relation_tuples
         WHERE object_type = 'file' AND object_id = ? AND subject_type = 'user' AND subject_id = ? AND subject_relation = ''
       UNION ALL
       SELECT ${RANK} FROM relation_tuples
         WHERE object_type = 'file' AND object_id = ? AND subject_type = 'email' AND subject_id = ? AND subject_relation = ''
       UNION ALL
       SELECT ${RANK} FROM relation_tuples t JOIN user_spaces us ON us.space_id = t.subject_id
         WHERE t.object_type = 'file' AND t.object_id = ? AND t.subject_type = 'space' AND t.subject_relation = 'member'
       UNION ALL
       SELECT us.rank FROM relation_tuples t JOIN user_spaces us ON us.space_id = t.subject_id
         WHERE t.object_type = 'file' AND t.object_id = ? AND t.relation = 'space' AND t.subject_type = 'space'
     )`,
    [userSub, fileId, userSub, fileId, addr, fileId, fileId],
  );
  return rankToRole(row?.rank ?? 0);
}

/**
 * The user's role from *folder grants* covering `path` in `spaceId` — a grant on
 * the path or any ancestor folder applies (folders inherit downward). Subjects:
 * user, email (pending), or a place's members. Null if no folder grant applies.
 */
export async function folderRole(db: Db, spaceId: string, path: string, userSub: string, email = ""): Promise<Role | null> {
  const ids = ancestorFolderPaths(path).map((p) => folderObjectId(spaceId, p));
  if (!ids.length) return null;
  const ph = ids.map(() => "?").join(",");
  const addr = normalizeEmail(email);
  const row = await db.first<{ rank: number | null }>(
    `${USER_SPACES}
     SELECT MAX(rank) AS rank FROM (
       SELECT ${RANK} AS rank FROM relation_tuples
         WHERE object_type = 'folder' AND object_id IN (${ph}) AND subject_type = 'user' AND subject_id = ? AND subject_relation = ''
       UNION ALL
       SELECT ${RANK} FROM relation_tuples
         WHERE object_type = 'folder' AND object_id IN (${ph}) AND subject_type = 'email' AND subject_id = ? AND subject_relation = ''
       UNION ALL
       SELECT ${RANK} FROM relation_tuples t JOIN user_spaces us ON us.space_id = t.subject_id
         WHERE t.object_type = 'folder' AND t.object_id IN (${ph}) AND t.subject_type = 'space' AND t.subject_relation = 'member'
     )`,
    [userSub, ...ids, userSub, ...ids, addr, ...ids],
  );
  return rankToRole(row?.rank ?? 0);
}

/** Effective role on a *path* in a space: space membership ∪ any covering folder grant. */
export async function pathRole(db: Db, spaceId: string, path: string, userSub: string, email = ""): Promise<Role | null> {
  const [sr, fr] = await Promise.all([spaceRole(db, spaceId, userSub), folderRole(db, spaceId, path, userSub, email)]);
  return maxRole(sr, fr);
}

/** Grants on a folder (space + path), subject directory info joined in — for the Share dialog. */
export async function folderGrantsDetailed(db: Db, spaceId: string, path: string): Promise<GrantDetail[]> {
  const objectId = folderObjectId(spaceId, path);
  const rows = await db.all<{
    relation: string;
    subject_type: SubjectType;
    subject_id: string;
    subject_relation: string;
    name: string | null;
    email: string | null;
    picture: string | null;
  }>(
    `SELECT t.relation, t.subject_type, t.subject_id, t.subject_relation,
            u.name AS name, u.email AS email, u.picture AS picture
       FROM relation_tuples t
       LEFT JOIN users u ON t.subject_type = 'user' AND u.sub = t.subject_id
       WHERE t.object_type = 'folder' AND t.object_id = ? AND t.relation IN ('owner','editor','viewer')`,
    [objectId],
  );
  return rows.map((r) => ({
    objectType: "folder" as const,
    objectId,
    relation: r.relation,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    subjectRelation: r.subject_relation,
    name: r.name,
    email: r.subject_type === "email" ? r.subject_id : r.email,
    picture: r.picture,
  }));
}

/** Folders shared *with* the user (direct or via a place they belong to) — for "Shared with me". */
export async function sharedFolders(db: Db, userSub: string): Promise<{ spaceId: string; path: string; role: Role }[]> {
  const rows = await db.all<{ object_id: string; rank: number }>(
    `${USER_SPACES}
     SELECT object_id, MAX(rank) AS rank FROM (
       SELECT object_id, ${RANK} AS rank FROM relation_tuples
         WHERE object_type = 'folder' AND subject_type = 'user' AND subject_id = ? AND subject_relation = ''
       UNION ALL
       SELECT t.object_id, ${RANK} FROM relation_tuples t JOIN user_spaces us ON us.space_id = t.subject_id
         WHERE t.object_type = 'folder' AND t.subject_type = 'space' AND t.subject_relation = 'member'
     ) GROUP BY object_id`,
    [userSub, userSub],
  );
  const out: { spaceId: string; path: string; role: Role }[] = [];
  for (const r of rows) {
    const parsed = parseFolderObjectId(r.object_id);
    const role = rankToRole(r.rank);
    if (parsed && role) out.push({ ...parsed, role });
  }
  return out;
}

/** Does the user hold at least `required` on the object? */
export async function check(
  db: Db,
  args: { objectType: ObjectType; objectId: string; required: Role; userSub: string; email?: string },
): Promise<boolean> {
  const role =
    args.objectType === "file"
      ? await fileRole(db, args.objectId, args.userSub, args.email ?? "")
      : await spaceRole(db, args.objectId, args.userSub);
  return role != null && ROLE_RANK[role] >= ROLE_RANK[args.required];
}
