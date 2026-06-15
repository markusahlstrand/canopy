import type { Db } from "./db";
import type { Role, Space, VersionPolicyKind } from "./types";
import { deleteTuple, memberSpaceIds, spaceRole, writeTuple } from "./authz";
import { ensureConnection } from "./connections";

interface SpaceRow {
  id: string;
  name: string;
  kind: string;
  created_by: string;
  created_at: string;
  icon: string | null;
  color: string | null;
  version_policy: string | null;
  version_days: number | null;
}
/** Coerce the stored column (NULL on pre-migration-21 rows) to a known policy. */
const toPolicy = (v: string | null): VersionPolicyKind =>
  v === "all" || v === "days" ? v : "smart";
const toSpace = (r: SpaceRow): Space => ({
  id: r.id,
  name: r.name,
  kind: r.kind === "group" ? "group" : r.kind === "connected" ? "connected" : "personal",
  createdBy: r.created_by,
  createdAt: r.created_at,
  icon: r.icon ?? null,
  color: r.color ?? null,
  versionPolicy: toPolicy(r.version_policy),
  versionDays: r.version_days ?? null,
});

/** Deterministic personal-space id for a user. */
export const personalSpaceId = (userSub: string): string => `personal:${userSub}`;

/** Ensure the user's personal space exists (idempotent). Returns its id. */
export async function ensurePersonalSpace(db: Db, userSub: string): Promise<string> {
  const id = personalSpaceId(userSub);
  await db.run(
    `INSERT OR IGNORE INTO spaces (id, name, kind, created_by, created_at) VALUES (?, 'My Drive', 'personal', ?, ?)`,
    [id, userSub, new Date().toISOString()],
  );
  await writeTuple(db, { objectType: "space", objectId: id, relation: "owner", subjectType: "user", subjectId: userSub });
  return id;
}

/** Deterministic per-user connected-space id for a plugin's connector. */
export const connectorSpaceId = (userSub: string, pluginId: string): string => `connector:${pluginId}:${userSub}`;

/**
 * Ensure the user's connected space for a plugin exists (idempotent). Returns its
 * id. The space is owned by the user — so it joins the ACL scope and search reaches
 * its files — but read-only to user writes (only the reconciler writes its rows).
 * Backed by a {@link Connection} row so a crawl can checkpoint against it.
 */
export async function ensureConnectorSpace(db: Db, userSub: string, pluginId: string, name: string): Promise<string> {
  const id = connectorSpaceId(userSub, pluginId);
  await db.run(
    `INSERT OR IGNORE INTO spaces (id, name, kind, created_by, created_at) VALUES (?, ?, 'connected', ?, ?)`,
    [id, name, userSub, new Date().toISOString()],
  );
  await writeTuple(db, { objectType: "space", objectId: id, relation: "owner", subjectType: "user", subjectId: userSub });
  await ensureConnection(db, { id, tenantId: id, ownerId: userSub, type: pluginId, name });
  return id;
}

/** Create a shared (group) space owned by its creator. */
export async function createSpace(
  db: Db,
  input: { name: string; createdBy: string; icon?: string | null; color?: string | null },
): Promise<Space> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const icon = input.icon ?? null;
  const color = input.color ?? null;
  await db.run(
    `INSERT INTO spaces (id, name, kind, created_by, created_at, icon, color) VALUES (?, ?, 'group', ?, ?, ?, ?)`,
    [id, input.name, input.createdBy, now, icon, color],
  );
  await writeTuple(db, { objectType: "space", objectId: id, relation: "owner", subjectType: "user", subjectId: input.createdBy });
  return {
    id,
    name: input.name,
    kind: "group",
    createdBy: input.createdBy,
    createdAt: now,
    icon,
    color,
    versionPolicy: "smart",
    versionDays: null,
  };
}

/** Grant a user a role in a space (a tuple `space:<id>#<role>@user:<sub>`). */
export async function addMember(db: Db, spaceId: string, userSub: string, role: Role): Promise<void> {
  // One role per member: clear any existing role grants first.
  await removeMember(db, spaceId, userSub);
  await writeTuple(db, { objectType: "space", objectId: spaceId, relation: role, subjectType: "user", subjectId: userSub });
}

/** Remove a member or a pending invite. `principal` is a user sub or an invited email. */
export async function removeMember(db: Db, spaceId: string, principal: string): Promise<void> {
  for (const role of ["owner", "editor", "viewer"] as const) {
    await deleteTuple(db, { objectType: "space", objectId: spaceId, relation: role, subjectType: "user", subjectId: principal });
    await deleteTuple(db, { objectType: "space", objectId: spaceId, relation: role, subjectType: "email", subjectId: principal });
  }
}

export interface SpaceMember {
  /** The user's sub, or "" for a pending email invite. */
  sub: string;
  role: Role;
  email: string | null;
  name: string | null;
  /** True for an email invite not yet claimed (the person hasn't signed in). */
  pending: boolean;
}

/** Members of a space + pending email invites (with directory info where known). */
export async function listMembers(db: Db, spaceId: string): Promise<SpaceMember[]> {
  const userRows = await db.all<{ sub: string; relation: string; email: string | null; name: string | null }>(
    `SELECT t.subject_id AS sub, t.relation AS relation, u.email AS email, u.name AS name
       FROM relation_tuples t LEFT JOIN users u ON u.sub = t.subject_id
       WHERE t.object_type = 'space' AND t.object_id = ? AND t.subject_type = 'user'
         AND t.relation IN ('owner','editor','viewer')
       ORDER BY CASE t.relation WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.name`,
    [spaceId],
  );
  const inviteRows = await db.all<{ email: string; relation: string }>(
    `SELECT subject_id AS email, relation FROM relation_tuples
       WHERE object_type = 'space' AND object_id = ? AND subject_type = 'email'
         AND relation IN ('owner','editor','viewer')`,
    [spaceId],
  );
  return [
    ...userRows.map((r) => ({ sub: r.sub, role: r.relation as Role, email: r.email, name: r.name, pending: false })),
    ...inviteRows.map((r) => ({ sub: "", role: r.relation as Role, email: r.email, name: null, pending: true })),
  ];
}

export async function getSpace(db: Db, id: string): Promise<Space | null> {
  const row = await db.first<SpaceRow>("SELECT * FROM spaces WHERE id = ?", [id]);
  return row ? toSpace(row) : null;
}

/** Rename a space. Returns the updated space, or null if it doesn't exist. */
export async function renameSpace(db: Db, id: string, name: string): Promise<Space | null> {
  await db.run("UPDATE spaces SET name = ? WHERE id = ?", [name, id]);
  return getSpace(db, id);
}

/** This space's version-retention policy (defaults to `'smart'` for unknown/older rows). */
export async function getVersionPolicy(
  db: Db,
  id: string,
): Promise<{ policy: VersionPolicyKind; days: number | null }> {
  const row = await db.first<{ version_policy: string | null; version_days: number | null }>(
    "SELECT version_policy, version_days FROM spaces WHERE id = ?",
    [id],
  );
  return { policy: toPolicy(row?.version_policy ?? null), days: row?.version_days ?? null };
}

/**
 * Set a space's version-retention policy. `days` is only meaningful for `'days'`
 * (cleared to NULL otherwise, so a later switch back can't inherit a stale window).
 */
export async function setVersionPolicy(
  db: Db,
  id: string,
  policy: VersionPolicyKind,
  days: number | null,
): Promise<void> {
  await db.run("UPDATE spaces SET version_policy = ?, version_days = ? WHERE id = ?", [
    policy,
    policy === "days" ? days : null,
    id,
  ]);
}

/**
 * Spaces the user can see in the switcher (personal + any group they belong to).
 * Excludes `connected` spaces: those are the persisted index over a connector and
 * are presented separately (derived live from the plugin's config, with a stable
 * public id), so they'd otherwise show twice. They remain in `memberSpaceIds`, so
 * search still reaches their files.
 */
export async function listSpaces(db: Db, userSub: string): Promise<Space[]> {
  const ids = await memberSpaceIds(db, userSub);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = await db.all<SpaceRow>(
    `SELECT * FROM spaces WHERE id IN (${placeholders}) AND kind <> 'connected' ORDER BY kind, name`,
    ids,
  );
  return rows.map(toSpace);
}

/** A space plus this user's role + mount preference (for the switcher / My Drive). */
export interface SpaceView extends Space {
  role: Role;
  /** Show inline in My Drive (true by default; personal is always true). */
  mounted: boolean;
}

export async function listSpacesForUser(db: Db, userSub: string): Promise<SpaceView[]> {
  const spaces = await listSpaces(db, userSub);
  const out: SpaceView[] = [];
  for (const s of spaces) {
    const role = (await spaceRole(db, s.id, userSub)) ?? "viewer";
    const pref = await db.first<{ mounted: number }>(
      "SELECT mounted FROM space_prefs WHERE user_sub = ? AND space_id = ?",
      [userSub, s.id],
    );
    const mounted = s.kind === "personal" ? true : pref ? pref.mounted === 1 : true;
    out.push({ ...s, role, mounted });
  }
  return out;
}

/** Set whether a group space is mounted inline in the user's drive. */
export async function setMounted(db: Db, userSub: string, spaceId: string, mounted: boolean): Promise<void> {
  await db.run(
    `INSERT INTO space_prefs (user_sub, space_id, mounted) VALUES (?, ?, ?)
     ON CONFLICT(user_sub, space_id) DO UPDATE SET mounted = excluded.mounted`,
    [userSub, spaceId, mounted ? 1 : 0],
  );
}
