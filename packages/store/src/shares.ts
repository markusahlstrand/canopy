import type { Db } from "./db";
import type { Role } from "./types";
import { sha256hex } from "./hash";

/**
 * Share links: an unguessable secret that grants a *scoped capability* — a role
 * on one file, folder, or whole space — to anyone holding it, with no Canopy
 * account required. Sibling to app-passwords.ts: only the secret's SHA-256 is
 * stored, the plaintext is shown once at creation.
 *
 * The same secret is consumed two ways: in a web link (`/s/<secret>`), and as
 * the HTTP Basic password when mounting over WebDAV (where it rides in the
 * Authorization header, redacted from logs — not in the URL). A share is a
 * capability, not an identity grant, so it lives here rather than in
 * relation_tuples; access runs *as the share's creator*, narrowed to the
 * shared subtree and the share's role.
 */

export type ShareObjectType = "file" | "folder" | "space";

/** A share with its secret stripped — safe to list back to the owner. */
export interface ShareInfo {
  id: string;
  objectType: ShareObjectType;
  spaceId: string;
  fileId: string | null;
  /** Folder path for objectType='folder'; '' otherwise. */
  path: string;
  role: Role;
  label: string | null;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

/** What a verified secret resolves to — the capability a request runs with. */
export interface VerifiedShare {
  id: string;
  objectType: ShareObjectType;
  spaceId: string;
  fileId: string | null;
  path: string;
  role: Role;
  /** The user whose access backs the capability (operations run as them). */
  createdBy: string;
}

export interface CreateShareInput {
  objectType: ShareObjectType;
  spaceId: string;
  /** Required for objectType='file'. */
  fileId?: string | null;
  /** Required for objectType='folder' (the folder's virtual path). */
  path?: string;
  role: Role;
  label?: string | null;
  /** ISO timestamp, or null/undefined for a link that never expires. */
  expiresAt?: string | null;
}

/** Which shares to list — by exact object. */
export type ShareFilter =
  | { objectType: "file"; fileId: string }
  | { objectType: "folder"; spaceId: string; path: string }
  | { objectType: "space"; spaceId: string };

interface ShareRow {
  id: string;
  object_type: ShareObjectType;
  space_id: string;
  file_id: string | null;
  path: string;
  role: Role;
  label: string | null;
  created_by: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

const toInfo = (r: ShareRow): ShareInfo => ({
  id: r.id,
  objectType: r.object_type,
  spaceId: r.space_id,
  fileId: r.file_id,
  path: r.path,
  role: r.role,
  label: r.label,
  createdBy: r.created_by,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  expiresAt: r.expires_at,
});

/** 24 bytes of CSPRNG randomness, URL-safe base64 — same shape as an app password. */
function randomSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function createShare(db: Db, createdBy: string, input: CreateShareInput): Promise<{ id: string; secret: string }> {
  const id = crypto.randomUUID();
  const secret = randomSecret();
  const secretHash = await sha256hex(new TextEncoder().encode(secret));
  await db.run(
    `INSERT INTO shares (id, object_type, space_id, file_id, path, role, secret_hash, label, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.objectType,
      input.spaceId,
      input.objectType === "file" ? (input.fileId ?? null) : null,
      input.objectType === "folder" ? (input.path ?? "") : "",
      input.role,
      secretHash,
      input.label ?? null,
      createdBy,
      new Date().toISOString(),
      input.expiresAt ?? null,
    ],
  );
  return { id, secret };
}

/**
 * Resolve a secret to its capability, or null if unknown, revoked, or expired.
 * Bumps last_used_at on a hit. Verification is by the secret alone — the
 * caller-supplied username (if any) is for audit logging, never the decision.
 */
export async function verifyShare(db: Db, secret: string): Promise<VerifiedShare | null> {
  if (!secret) return null;
  const secretHash = await sha256hex(new TextEncoder().encode(secret));
  const row = await db.first<ShareRow>("SELECT * FROM shares WHERE secret_hash = ?", [secretHash]);
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return null;
  await db.run("UPDATE shares SET last_used_at = ? WHERE id = ?", [new Date().toISOString(), row.id]);
  return {
    id: row.id,
    objectType: row.object_type,
    spaceId: row.space_id,
    fileId: row.file_id,
    path: row.path,
    role: row.role,
    createdBy: row.created_by,
  };
}

/** Active (non-revoked) shares on one object, newest first. */
export async function listShares(db: Db, filter: ShareFilter): Promise<ShareInfo[]> {
  let where = "object_type = ? AND revoked_at IS NULL";
  const params: unknown[] = [filter.objectType];
  if (filter.objectType === "file") {
    where += " AND file_id = ?";
    params.push(filter.fileId);
  } else if (filter.objectType === "folder") {
    where += " AND space_id = ? AND path = ?";
    params.push(filter.spaceId, filter.path);
  } else {
    where += " AND space_id = ?";
    params.push(filter.spaceId);
  }
  const rows = await db.all<ShareRow>(`SELECT * FROM shares WHERE ${where} ORDER BY created_at DESC`, params);
  return rows.map(toInfo);
}

/** A single share by id (for permission checks before revoke), or null. */
export async function getShare(db: Db, id: string): Promise<ShareInfo | null> {
  const row = await db.first<ShareRow>("SELECT * FROM shares WHERE id = ?", [id]);
  return row ? toInfo(row) : null;
}

/** Soft-revoke a share (the secret stops working immediately). */
export async function revokeShare(db: Db, id: string): Promise<void> {
  await db.run("UPDATE shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [new Date().toISOString(), id]);
}
