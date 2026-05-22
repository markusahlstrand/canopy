import type { Db } from "./db";
import type { Role } from "./types";
import { ROLE_RANK, spaceRole } from "./authz";
import { addMember } from "./spaces";

/**
 * Single-use invite links for joining a space. Unlike share-by-email (which
 * pre-binds a specific address), an invite link is an opaque token anyone can
 * open; whoever signs in and accepts becomes a member at the link's role. The
 * link is consumed on first accept (`accepted_by` set) or once it expires.
 */
export interface SpaceInvite {
  token: string;
  spaceId: string;
  role: Role;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  acceptedBy: string | null;
  acceptedAt: string | null;
}

interface InviteRow {
  token: string;
  space_id: string;
  role: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
}
const toInvite = (r: InviteRow): SpaceInvite => ({
  token: r.token,
  spaceId: r.space_id,
  role: r.role as Role,
  createdBy: r.created_by,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  acceptedBy: r.accepted_by,
  acceptedAt: r.accepted_at,
});

/** Default lifetime of an invite link: 7 days. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Opaque, URL-safe token (192 bits) — unguessable, like an app password. */
function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function createInvite(
  db: Db,
  input: { spaceId: string; role: Role; createdBy: string; ttlMs?: number },
): Promise<SpaceInvite> {
  const token = randomToken();
  const now = new Date();
  const ttl = input.ttlMs ?? INVITE_TTL_MS;
  const expiresAt = ttl > 0 ? new Date(now.getTime() + ttl).toISOString() : null;
  await db.run(
    `INSERT INTO space_invites (token, space_id, role, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [token, input.spaceId, input.role, input.createdBy, now.toISOString(), expiresAt],
  );
  return {
    token,
    spaceId: input.spaceId,
    role: input.role,
    createdBy: input.createdBy,
    createdAt: now.toISOString(),
    expiresAt,
    acceptedBy: null,
    acceptedAt: null,
  };
}

export async function getInvite(db: Db, token: string): Promise<SpaceInvite | null> {
  const row = await db.first<InviteRow>("SELECT * FROM space_invites WHERE token = ?", [token]);
  return row ? toInvite(row) : null;
}

export type InviteStatus = "valid" | "used" | "expired" | "not_found";

export function inviteStatus(invite: SpaceInvite | null, now = Date.now()): InviteStatus {
  if (!invite) return "not_found";
  if (invite.acceptedBy) return "used";
  if (invite.expiresAt && Date.parse(invite.expiresAt) <= now) return "expired";
  return "valid";
}

/** Active (unused, unexpired) invite links for a space, newest first. */
export async function listInvites(db: Db, spaceId: string): Promise<SpaceInvite[]> {
  const now = new Date().toISOString();
  const rows = await db.all<InviteRow>(
    `SELECT * FROM space_invites
       WHERE space_id = ? AND accepted_by IS NULL AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC`,
    [spaceId, now],
  );
  return rows.map(toInvite);
}

export async function revokeInvite(db: Db, spaceId: string, token: string): Promise<void> {
  await db.run("DELETE FROM space_invites WHERE token = ? AND space_id = ?", [token, spaceId]);
}

export type AcceptResult =
  | { ok: true; spaceId: string; alreadyMember: boolean }
  | { ok: false; reason: "not_found" | "used" | "expired" };

/**
 * Redeem an invite for `userSub`. Single-use: the claim is an atomic conditional
 * UPDATE, so the loser of a race sees it already used. If the caller already has
 * an equal-or-greater role we leave the link unspent (so it isn't wasted on a
 * member who clicks their own link).
 */
export async function acceptInvite(db: Db, token: string, userSub: string): Promise<AcceptResult> {
  const invite = await getInvite(db, token);
  const status = inviteStatus(invite);
  if (!invite || status === "not_found") return { ok: false, reason: "not_found" };
  if (status === "expired") return { ok: false, reason: "expired" };
  if (status === "used") {
    // Idempotent: the same user re-opening the link they already accepted is fine.
    return invite.acceptedBy === userSub
      ? { ok: true, spaceId: invite.spaceId, alreadyMember: true }
      : { ok: false, reason: "used" };
  }
  const existing = await spaceRole(db, invite.spaceId, userSub);
  if (existing && ROLE_RANK[existing] >= ROLE_RANK[invite.role]) {
    return { ok: true, spaceId: invite.spaceId, alreadyMember: true };
  }
  const claimed = await db.run(
    "UPDATE space_invites SET accepted_by = ?, accepted_at = ? WHERE token = ? AND accepted_by IS NULL",
    [userSub, new Date().toISOString(), token],
  );
  if (claimed.rowsAffected === 0) return { ok: false, reason: "used" };
  await addMember(db, invite.spaceId, userSub, invite.role);
  return { ok: true, spaceId: invite.spaceId, alreadyMember: false };
}
