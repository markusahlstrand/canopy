import type { Db } from "./db";
import type { BlobRepo, BlobStore } from "./blob-store";
import type { FileRecord, FileVersion, FileWithVersion, Role, Space, User } from "./types";
import { blobKey, commitUpload, prepareBlob, releaseBlob, type PrepareResult } from "./blobs";
import { versionsToPrune } from "./retention";
import { sha256hex } from "./hash";
import {
  ROLE_RANK,
  deleteTuple,
  fileGrantsDetailed,
  fileRole,
  folderGrantsDetailed,
  folderObjectId,
  folderRole,
  maxRole,
  parseFolderObjectId,
  memberSpaceIds,
  pathRole,
  sharedFolders,
  spaceFolderRole,
  spaceRole,
  writeTuple,
  type GrantDetail,
  type SubjectType,
} from "./authz";
import {
  addMember,
  createSpace as createGroupSpace,
  ensurePersonalSpace,
  getSpace,
  listMembers,
  listSpacesForUser,
  removeMember,
  renameSpace,
  setMounted,
  type SpaceMember,
  type SpaceView,
} from "./spaces";
import {
  acceptInvite as redeemInvite,
  createInvite,
  getInvite,
  inviteStatus,
  listInvites,
  revokeInvite,
  type InviteStatus,
  type SpaceInvite,
} from "./invites";
import {
  connectedUsers,
  ensureUser,
  findUserByEmail,
  normalizeEmail,
  pendingSpaceInvites,
  resolveInvites,
  type PendingSpaceInvite,
} from "./users";
import {
  createAppPassword as createAppPwd,
  deleteAppPassword as deleteAppPwd,
  listAppPasswords as listAppPwds,
  verifyAppPassword as verifyAppPwd,
  type AppPassword,
} from "./app-passwords";
import {
  createShare as createShareRow,
  getShare as getShareRow,
  listShares as listShareRows,
  revokeShare as revokeShareRow,
  verifyShare as verifyShareRow,
  type ShareFilter,
  type ShareInfo,
  type VerifiedShare,
} from "./shares";
import { deletePluginSettings, getPluginSettings, setPluginSettings } from "./plugin-settings";
import { getInstalledPlugins, setInstalledPlugins } from "./plugin-installs";
import {
  type CustomPlugin,
  deleteCustomPlugin,
  getCustomPlugin,
  listCustomPlugins,
  upsertCustomPlugin,
} from "./custom-plugins";
import {
  applySpacePlugin as applySpacePluginRow,
  getSpacePlugins,
  pluginIdsForSpaces,
  removeSpacePlugin as removeSpacePluginRow,
  spacesWithPlugin,
} from "./space-plugins";

export class NotFoundError extends Error {
  constructor(message = "not found") {
    super(message);
    this.name = "NotFoundError";
  }
}
export class PermissionError extends Error {
  constructor(message = "forbidden") {
    super(message);
    this.name = "PermissionError";
  }
}
export class BlobMissingError extends Error {
  constructor(message = "blob has not been uploaded") {
    super(message);
    this.name = "BlobMissingError";
  }
}

/** Normalize a virtual-folder path: trim slashes, drop empty/`.` segments. */
export function normPath(path: string): string {
  return path
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== ".")
    .join("/");
}

/** Immediate child folder names of `dir`, derived from the set of file paths. */
export function subfolders(dir: string, paths: string[]): string[] {
  const prefix = dir ? `${dir}/` : "";
  const names = new Set<string>();
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (!rest) continue;
    names.add(rest.split("/")[0]!);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

interface FileRow {
  id: string;
  tenant_id: string; // holds the space id
  owner_id: string;
  name: string;
  current_version_id: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}
interface VersionRow {
  id: string;
  file_id: string;
  source: string;
  blob_hash: string | null;
  connector_id: string | null;
  external_key: string | null;
  etag: string | null;
  mime: string | null;
  size: number;
  created_at: string;
  created_by: string;
  keep: number;
}
interface CommentRow {
  id: string;
  file_id: string;
  author_id: string;
  body: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toFile(r: FileRow): FileRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    ownerId: r.owner_id,
    name: r.name,
    currentVersionId: r.current_version_id,
    metadata: parseMeta(r.metadata),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}
function toVersion(r: VersionRow): FileVersion {
  return {
    id: r.id,
    fileId: r.file_id,
    source: r.source === "external" ? "external" : "blob",
    blobKey: r.blob_hash,
    connectorId: r.connector_id,
    externalKey: r.external_key,
    etag: r.etag,
    mime: r.mime,
    size: r.size,
    createdAt: r.created_at,
    createdBy: r.created_by,
    keep: r.keep === 1,
  };
}
function parseMeta(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const VERSION_COLS =
  "v.id AS v_id, v.source, v.blob_hash, v.connector_id, v.external_key, v.etag, v.mime, v.size, v.created_by, v.created_at AS v_created_at, v.keep";

type JoinedRow = FileRow & Partial<VersionRow> & { v_id: string | null; v_created_at: string | null };

function joinedToFileWithVersion(r: JoinedRow): FileWithVersion {
  return {
    ...toFile(r),
    version: r.v_id
      ? toVersion({
          id: r.v_id,
          file_id: r.id,
          source: r.source ?? "blob",
          blob_hash: r.blob_hash ?? null,
          connector_id: r.connector_id ?? null,
          external_key: r.external_key ?? null,
          etag: r.etag ?? null,
          mime: r.mime ?? null,
          size: r.size ?? 0,
          created_at: r.v_created_at ?? r.created_at,
          created_by: r.created_by ?? r.owner_id,
          keep: r.keep ?? 0,
        })
      : null,
  };
}

/** A listed file enriched for display: who it's shared with + a friendly owner label. */
export interface ListedFile extends FileWithVersion {
  /** Labels (emails / names / space names) the file is shared with, beyond its owner. */
  sharedWith: string[];
  ownerLabel: string;
}

/** A version in a file's history, with a friendly label for who created it. */
export interface VersionEntry extends FileVersion {
  createdByLabel: string;
}

/** A comment with a friendly label for its author (resolved from the user directory). */
export interface CommentEntry {
  id: string;
  authorId: string;
  authorLabel: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * How long the current version stays open to coalescing. Successive blob saves by
 * the same author within this window collapse into that version instead of
 * appending a new one — so one editing session is one version, not hundreds. The
 * version "seals" once it's older than the window (measured from when it was first
 * created, so continuous editing still cuts a fresh version each window).
 */
export const DEFAULT_COALESCE_WINDOW_MS = 10 * 60_000;

export interface CreateFileInput {
  name: string;
  hash: string;
  mime?: string;
  path?: string;
  metadata?: Record<string, unknown>;
}

export interface Caller {
  sub: string;
  email?: string;
  /** Whether the IdP verified the caller's email — required to claim email-bound invites. */
  emailVerified?: boolean;
}

/**
 * One processor run over a file, flattened from a file's `metadata.processing`
 * with the file it belongs to — for a plugin's activity view. Newest first.
 */
export interface ProcessingRun {
  fileId: string;
  fileName: string;
  spaceName: string;
  at: string;
  plugin: string;
  status: "ok" | "error";
  model?: string;
  labels?: string[];
  described?: boolean;
  note?: string;
}

/**
 * File/version operations over a {@link Db} + {@link BlobStore}, with access
 * enforced by relation tuples (see authz.ts). A file lives in a **space**
 * (stored in `tenant_id`); blobs are content-addressed within their space.
 */
export class FileService {
  constructor(
    private readonly db: Db,
    private readonly store: BlobStore,
    private readonly repo: BlobRepo,
    private readonly opts: { globalDedup?: boolean; versionCoalesceWindowMs?: number } = {},
  ) {}

  keyFor(spaceId: string, hash: string): string {
    return blobKey(spaceId, hash, this.opts.globalDedup);
  }

  /** Ensure + return the caller's personal space id (the default drive). */
  personalSpace(userSub: string): Promise<string> {
    return ensurePersonalSpace(this.db, userSub);
  }

  /** Backfill the caller's directory entry from their session profile (idempotent). */
  ensureUser(profile: { sub: string; email?: string | null; name?: string | null; picture?: string | null }): Promise<void> {
    return ensureUser(this.db, profile);
  }

  /** Spaces the caller can see, with role + mount preference (switcher / My Drive). */
  async spaces(userSub: string): Promise<SpaceView[]> {
    await ensurePersonalSpace(this.db, userSub); // always at least "My Drive"
    return listSpacesForUser(this.db, userSub);
  }

  /** Pin/unpin a group space into the caller's drive. Requires viewer+ on the space. */
  async setSpaceMounted(caller: Caller, spaceId: string, mounted: boolean): Promise<void> {
    await this.requireSpace(caller.sub, spaceId, "viewer");
    await setMounted(this.db, caller.sub, spaceId, mounted);
  }

  /** Create a shared group space (e.g. a family); the caller becomes its owner. */
  createSpace(caller: Caller, name: string): Promise<Space> {
    return createGroupSpace(this.db, { name, createdBy: caller.sub });
  }

  /** Rename a group space. Requires owner on the space. */
  async renameSpace(caller: Caller, spaceId: string, name: string): Promise<Space> {
    await this.requireSpace(caller.sub, spaceId, "owner");
    const updated = await renameSpace(this.db, spaceId, name);
    if (!updated) throw new NotFoundError("space not found");
    return updated;
  }

  /** Members of a space. Requires viewer+ on the space. */
  async spaceMembers(caller: Caller, spaceId: string): Promise<SpaceMember[]> {
    await this.requireSpace(caller.sub, spaceId, "viewer");
    return listMembers(this.db, spaceId);
  }

  /**
   * Add a member by email. Requires owner. If they already have an account it's a
   * direct grant; otherwise a **pending invite** (an `email:` space grant) that
   * resolves to membership when they first sign in with that (verified) email.
   */
  async addSpaceMember(caller: Caller, spaceId: string, email: string, role: Role): Promise<SpaceMember> {
    await this.requireSpace(caller.sub, spaceId, "owner");
    const addr = normalizeEmail(email);
    const user = await findUserByEmail(this.db, addr);
    if (user) {
      await addMember(this.db, spaceId, user.sub, role);
      return { sub: user.sub, role, email: user.email, name: user.name, pending: false };
    }
    await writeTuple(this.db, { objectType: "space", objectId: spaceId, relation: role, subjectType: "email", subjectId: addr });
    return { sub: "", role, email: addr, name: null, pending: true };
  }

  async removeSpaceMember(caller: Caller, spaceId: string, sub: string): Promise<void> {
    await this.requireSpace(caller.sub, spaceId, "owner");
    await removeMember(this.db, spaceId, sub);
  }

  /** Resolve an email to a known user (for turning share-by-email into a user grant). */
  resolveEmail(email: string) {
    return findUserByEmail(this.db, email);
  }

  // ── pending invites (email-bound, resolved on login or on demand) ────────────

  /**
   * Spaces the caller has been invited to by email but not yet joined — i.e.
   * `email:` grants awaiting them. Powers the in-app invites banner so an
   * already-signed-in user sees invites created after their last login (login
   * resolves them automatically; this catches the in-session gap).
   */
  async pendingInvites(caller: Caller): Promise<PendingSpaceInvite[]> {
    return pendingSpaceInvites(this.db, caller.email);
  }

  /**
   * Claim every email-bound invite for the caller's address, converting the
   * `email:` grants into `user:` grants (same effect as a verified login). Gated
   * on a verified email so nobody can claim another person's invite by signing
   * up with their address. Returns how many spaces were pending.
   */
  async acceptPendingInvites(caller: Caller): Promise<{ accepted: number }> {
    if (!caller.email || !caller.emailVerified) return { accepted: 0 };
    const pending = await pendingSpaceInvites(this.db, caller.email);
    await resolveInvites(this.db, caller.sub, caller.email);
    return { accepted: pending.length };
  }

  // ── invite links (single-use space invites) ─────────────────────────────────

  /** Mint a single-use invite link to a space, at a role. Requires owner. */
  async createSpaceInvite(caller: Caller, spaceId: string, role: Role): Promise<SpaceInvite> {
    await this.requireSpace(caller.sub, spaceId, "owner");
    return createInvite(this.db, { spaceId, role, createdBy: caller.sub });
  }

  /** Active (unused, unexpired) invite links for a space. Requires owner. */
  async spaceInvites(caller: Caller, spaceId: string): Promise<SpaceInvite[]> {
    await this.requireSpace(caller.sub, spaceId, "owner");
    return listInvites(this.db, spaceId);
  }

  /** Revoke an invite link before it's used. Requires owner. */
  async revokeSpaceInvite(caller: Caller, spaceId: string, token: string): Promise<void> {
    await this.requireSpace(caller.sub, spaceId, "owner");
    await revokeInvite(this.db, spaceId, token);
  }

  /**
   * Preview an invite link for the landing page — space name, role, and whether
   * it's still good. No auth: a recipient sees what they're joining before they
   * sign in. Returns only `status` when the token is unknown/used/expired.
   */
  async inviteInfo(token: string): Promise<{ status: InviteStatus; spaceId?: string; spaceName?: string; role?: Role }> {
    const invite = await getInvite(this.db, token);
    const status = inviteStatus(invite);
    if (!invite || status === "not_found") return { status: "not_found" };
    const space = await getSpace(this.db, invite.spaceId);
    return { status, spaceId: invite.spaceId, spaceName: space?.name, role: invite.role };
  }

  /**
   * Redeem an invite link: the caller joins the space at the link's role. The
   * caller's account (whichever they signed in with) becomes the member, so the
   * recipient effectively picks their identity by how they authenticate.
   */
  async acceptSpaceInvite(caller: Caller, token: string): Promise<{ spaceId: string; alreadyMember: boolean }> {
    const res = await redeemInvite(this.db, token, caller.sub);
    if (!res.ok) {
      if (res.reason === "not_found") throw new NotFoundError("invite not found");
      throw new Error(res.reason === "expired" ? "This invite link has expired." : "This invite link has already been used.");
    }
    return { spaceId: res.spaceId, alreadyMember: res.alreadyMember };
  }

  // ── uploads (into a space the caller can write to) ──────────────────────────
  // Staging a blob is gated on holding editor *somewhere* in the space (space
  // membership or any folder grant), not on space-level editor — a folder-grant
  // editor must be able to upload too. The blob is inert and refcounted until a
  // file references it, and the actual destination is gated by createFile's
  // requirePath; an unreferenced blob is GC'd, so this can't leak storage.

  async prepareUpload(spaceId: string, userSub: string, hash: string): Promise<PrepareResult> {
    await this.requireUpload(userSub, spaceId);
    return prepareBlob(this.repo, this.keyFor(spaceId, hash));
  }

  async commitUpload(spaceId: string, userSub: string, hash: string, bytes: Uint8Array) {
    await this.requireUpload(userSub, spaceId);
    return commitUpload(this.repo, this.store, { key: this.keyFor(spaceId, hash), expectedHash: hash, bytes });
  }

  // ── files ────────────────────────────────────────────────────────────────

  async createFile(spaceId: string, userSub: string, input: CreateFileInput): Promise<FileWithVersion> {
    await this.requirePath(userSub, spaceId, input.path ?? "", "editor");
    const key = this.keyFor(spaceId, input.hash);
    const blob = await this.repo.find(key);
    if (!blob) throw new BlobMissingError();

    const now = new Date().toISOString();
    const fileId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const metadata = { ...(input.metadata ?? {}), path: normPath(input.path ?? "") };

    await this.db.batch([
      {
        sql: `INSERT INTO files (id, tenant_id, owner_id, name, current_version_id, metadata, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [fileId, spaceId, userSub, input.name, versionId, JSON.stringify(metadata), now, now],
      },
      {
        sql: `INSERT INTO file_versions (id, file_id, source, blob_hash, mime, size, created_at, created_by)
              VALUES (?, ?, 'blob', ?, ?, ?, ?, ?)`,
        params: [versionId, fileId, key, input.mime ?? null, blob.size, now, userSub],
      },
      // Authz: the creator owns it, and it lives in the space (members inherit access).
      {
        sql: `INSERT OR IGNORE INTO relation_tuples (object_type, object_id, relation, subject_type, subject_id, subject_relation)
              VALUES ('file', ?, 'owner', 'user', ?, '')`,
        params: [fileId, userSub],
      },
      {
        sql: `INSERT OR IGNORE INTO relation_tuples (object_type, object_id, relation, subject_type, subject_id, subject_relation)
              VALUES ('file', ?, 'space', 'space', ?, '')`,
        params: [fileId, spaceId],
      },
    ]);

    return (await this.getFile({ sub: userSub }, fileId))!;
  }

  /** File record + current version. Requires viewer+. */
  async getFile(caller: Caller, id: string): Promise<FileWithVersion> {
    const file = await this.requirePerm(caller, id, "viewer");
    const version = file.currentVersionId ? await this.loadVersion(file.currentVersionId) : null;
    return { ...file, version };
  }

  /** Resolve a file by its virtual path within a space (for WebDAV). Requires viewer+. */
  async getByPath(userSub: string, spaceId: string, path: string): Promise<FileWithVersion | null> {
    await this.requirePath(userSub, spaceId, path, "viewer");
    const segs = normPath(path).split("/");
    const name = segs.pop() ?? "";
    const dir = segs.join("/");
    if (!name) return null;
    const row = await this.db.first<JoinedRow>(
      `SELECT f.*, ${VERSION_COLS}
       FROM files f LEFT JOIN file_versions v ON v.id = f.current_version_id
       WHERE f.tenant_id = ? AND f.deleted_at IS NULL AND json_extract(f.metadata, '$.path') = ? AND f.name = ?`,
      [spaceId, dir, name],
    );
    return row ? joinedToFileWithVersion(row) : null;
  }

  // ── WebDAV path-based writes (mount the drive in Finder/Explorer) ───────────
  // These mirror getByPath: they address files by their virtual path within a
  // space. PUT runs through the same content-addressed blob + versioning path as
  // the JSON API; folder ops rewrite the derived `metadata.path` of descendants.
  // Folders are virtual (derived from paths) with optional explicit rows for the
  // empty case, so a folder move/copy/delete touches every file under its prefix.

  /** A file row at a virtual path (no permission check — callers gate the space). */
  private async fileAtPath(spaceId: string, path: string): Promise<FileRecord | null> {
    const segs = normPath(path).split("/");
    const name = segs.pop() ?? "";
    const dir = segs.join("/");
    if (!name) return null;
    const row = await this.db.first<FileRow>(
      `SELECT * FROM files WHERE tenant_id = ? AND deleted_at IS NULL
         AND json_extract(metadata, '$.path') = ? AND name = ?`,
      [spaceId, dir, name],
    );
    return row ? toFile(row) : null;
  }

  /** What lives at a virtual path: a `file`, a `folder`, or `null` (nothing). Requires viewer+. */
  async pathKind(userSub: string, spaceId: string, path: string): Promise<"file" | "folder" | null> {
    await this.requirePath(userSub, spaceId, path, "viewer");
    const p = normPath(path);
    if (!p) return "folder"; // the space root is always a collection
    if (await this.fileAtPath(spaceId, p)) return "file";
    const prefix = `${p}/`;
    const folder = await this.db.first<{ x: number }>(
      "SELECT 1 AS x FROM folders WHERE space_id = ? AND (path = ? OR path LIKE ?) LIMIT 1",
      [spaceId, p, `${prefix}%`],
    );
    if (folder) return "folder";
    const inFolder = await this.db.first<{ x: number }>(
      `SELECT 1 AS x FROM files WHERE tenant_id = ? AND deleted_at IS NULL
         AND (json_extract(metadata, '$.path') = ? OR json_extract(metadata, '$.path') LIKE ?) LIMIT 1`,
      [spaceId, p, `${prefix}%`],
    );
    return inFolder ? "folder" : null;
  }

  /**
   * Create or replace the file at a virtual path with raw bytes (a WebDAV PUT).
   * Stores the bytes through the content-addressed blob path, then creates the
   * file (if new) or appends a version (if it exists). Requires editor+.
   */
  async putByPath(
    spaceId: string,
    userSub: string,
    path: string,
    bytes: Uint8Array,
    mime?: string,
  ): Promise<{ created: boolean }> {
    await this.requirePath(userSub, spaceId, path, "editor");
    const p = normPath(path);
    const segs = p.split("/");
    const name = segs.pop() ?? "";
    const dir = segs.join("/");
    if (!name) throw new Error("a file path is required");
    const hash = await sha256hex(bytes);
    // Reserve a blob ref; createFile/addVersion consume exactly one.
    await commitUpload(this.repo, this.store, { key: this.keyFor(spaceId, hash), expectedHash: hash, bytes });
    const existing = await this.fileAtPath(spaceId, p);
    if (existing) {
      await this.addVersion({ sub: userSub }, existing.id, { hash, mime });
      return { created: false };
    }
    await this.createFile(spaceId, userSub, { name, hash, mime, path: dir });
    return { created: true };
  }

  /**
   * Delete the file or folder at a virtual path (a WebDAV DELETE). A file goes to
   * Trash (owner-gated, recoverable); a folder soft-deletes every file in or under
   * it and drops its explicit rows. Folder delete is gated on space editor (not
   * per-file owner) since it spans many files. Requires editor+.
   */
  async deleteByPath(caller: Caller, spaceId: string, path: string): Promise<void> {
    await this.requirePath(caller.sub, spaceId, path, "editor", caller.email);
    const p = normPath(path);
    if (!p) throw new PermissionError("cannot delete the space root");
    const file = await this.fileAtPath(spaceId, p);
    if (file) {
      await this.deleteFile(caller, file.id);
      return;
    }
    if ((await this.pathKind(caller.sub, spaceId, p)) !== "folder") throw new NotFoundError();
    const prefix = `${p}/`;
    const now = new Date().toISOString();
    await this.db.run(
      `UPDATE files SET deleted_at = ?, updated_at = ? WHERE tenant_id = ? AND deleted_at IS NULL
         AND (json_extract(metadata, '$.path') = ? OR json_extract(metadata, '$.path') LIKE ?)`,
      [now, now, spaceId, p, `${prefix}%`],
    );
    await this.db.run("DELETE FROM folders WHERE space_id = ? AND (path = ? OR path LIKE ?)", [spaceId, p, `${prefix}%`]);
    // Drop any folder-share grants on the deleted folder or its descendants.
    await this.db.run("DELETE FROM relation_tuples WHERE object_type = 'folder' AND (object_id = ? OR object_id LIKE ?)", [
      folderObjectId(spaceId, p),
      `${folderObjectId(spaceId, `${p}/`)}%`,
    ]);
  }

  /**
   * Move/rename the file or folder at `from` to `to` within a space (a WebDAV
   * MOVE). For a file this updates its name + `metadata.path`; for a folder it
   * reparents every descendant's path and its explicit rows. `overwrite=false`
   * (the `Overwrite: F` header) fails if the destination exists. Requires editor+.
   */
  async moveByPath(
    caller: Caller,
    spaceId: string,
    fromPath: string,
    toPath: string,
    overwrite = true,
  ): Promise<{ created: boolean }> {
    await this.requirePath(caller.sub, spaceId, fromPath, "editor", caller.email);
    await this.requirePath(caller.sub, spaceId, toPath, "editor", caller.email);
    const from = normPath(fromPath);
    const to = normPath(toPath);
    if (!from || !to) throw new Error("source and destination paths are required");
    if (from === to) return { created: false };
    const destKind = await this.pathKind(caller.sub, spaceId, to);
    if (destKind && !overwrite) throw new PermissionError("destination exists");
    const now = new Date().toISOString();

    const file = await this.fileAtPath(spaceId, from);
    if (file) {
      if (destKind === "folder") throw new PermissionError("cannot overwrite a folder with a file");
      if (destKind === "file") {
        const victim = await this.fileAtPath(spaceId, to);
        if (victim) await this.purgeFile(caller, victim.id);
      }
      const toSegs = to.split("/");
      const newName = toSegs.pop() ?? file.name;
      const newDir = toSegs.join("/");
      await this.db.run("UPDATE files SET name = ?, metadata = json_set(metadata, '$.path', ?), updated_at = ? WHERE id = ?", [
        newName,
        newDir,
        now,
        file.id,
      ]);
      return { created: !destKind };
    }

    if ((await this.pathKind(caller.sub, spaceId, from)) !== "folder") throw new NotFoundError();
    if (destKind === "file") throw new PermissionError("cannot overwrite a file with a folder");
    const fromPrefix = `${from}/`;
    const rows = await this.db.all<{ id: string; p: string | null }>(
      `SELECT id, json_extract(metadata, '$.path') AS p FROM files
         WHERE tenant_id = ? AND deleted_at IS NULL
           AND (json_extract(metadata, '$.path') = ? OR json_extract(metadata, '$.path') LIKE ?)`,
      [spaceId, from, `${fromPrefix}%`],
    );
    for (const r of rows) {
      const np = to + (r.p ?? "").slice(from.length); // `from` is a prefix of the old path
      await this.db.run("UPDATE files SET metadata = json_set(metadata, '$.path', ?), updated_at = ? WHERE id = ?", [np, now, r.id]);
    }
    const folderRows = await this.db.all<{ path: string }>("SELECT path FROM folders WHERE space_id = ? AND (path = ? OR path LIKE ?)", [
      spaceId,
      from,
      `${fromPrefix}%`,
    ]);
    for (const f of folderRows) {
      const np = to + f.path.slice(from.length);
      await this.db.run("UPDATE OR REPLACE folders SET path = ? WHERE space_id = ? AND path = ?", [np, spaceId, f.path]);
    }
    await this.reparentFolderGrants(spaceId, from, to);
    return { created: !destKind };
  }

  // Move/rename a folder's share grants alongside the folder (their object_id
  // embeds the path), so a grant on "A/B" follows it to "X/B".
  private async reparentFolderGrants(spaceId: string, from: string, to: string): Promise<void> {
    const rows = await this.db.all<{ object_id: string }>(
      "SELECT DISTINCT object_id FROM relation_tuples WHERE object_type = 'folder' AND (object_id = ? OR object_id LIKE ?)",
      [folderObjectId(spaceId, from), `${folderObjectId(spaceId, `${from}/`)}%`],
    );
    for (const r of rows) {
      const parsed = parseFolderObjectId(r.object_id);
      if (!parsed) continue;
      const np = to + parsed.path.slice(from.length); // `from` is a prefix of the old path
      await this.db.run("UPDATE OR REPLACE relation_tuples SET object_id = ? WHERE object_type = 'folder' AND object_id = ?", [
        folderObjectId(spaceId, np),
        r.object_id,
      ]);
    }
  }

  /**
   * Copy the file or folder at `from` to `to` within a space (a WebDAV COPY). New
   * file rows reference the same content-addressed blob (a ref bump, not a byte
   * copy). `overwrite=false` fails if the destination exists. Requires editor+.
   */
  async copyByPath(
    caller: Caller,
    spaceId: string,
    fromPath: string,
    toPath: string,
    overwrite = true,
  ): Promise<{ created: boolean }> {
    await this.requirePath(caller.sub, spaceId, fromPath, "editor", caller.email);
    await this.requirePath(caller.sub, spaceId, toPath, "editor", caller.email);
    const from = normPath(fromPath);
    const to = normPath(toPath);
    if (!from || !to) throw new Error("source and destination paths are required");
    if (from === to) return { created: false };
    const destKind = await this.pathKind(caller.sub, spaceId, to);
    if (destKind && !overwrite) throw new PermissionError("destination exists");

    const file = await this.fileAtPath(spaceId, from);
    if (file) {
      if (destKind === "folder") throw new PermissionError("cannot overwrite a folder with a file");
      if (destKind === "file") {
        const victim = await this.fileAtPath(spaceId, to);
        if (victim) await this.purgeFile(caller, victim.id);
      }
      const toSegs = to.split("/");
      const newName = toSegs.pop() ?? file.name;
      const version = file.currentVersionId ? await this.loadVersion(file.currentVersionId) : null;
      await this.copyFileRow(caller.sub, file, version, spaceId, newName, toSegs.join("/"));
      return { created: !destKind };
    }

    if ((await this.pathKind(caller.sub, spaceId, from)) !== "folder") throw new NotFoundError();
    if (destKind === "file") throw new PermissionError("cannot overwrite a file with a folder");
    const fromPrefix = `${from}/`;
    const rows = await this.db.all<JoinedRow>(
      `SELECT f.*, ${VERSION_COLS}
         FROM files f LEFT JOIN file_versions v ON v.id = f.current_version_id
         WHERE f.tenant_id = ? AND f.deleted_at IS NULL
           AND (json_extract(f.metadata, '$.path') = ? OR json_extract(f.metadata, '$.path') LIKE ?)`,
      [spaceId, from, `${fromPrefix}%`],
    );
    for (const r of rows) {
      const fwv = joinedToFileWithVersion(r);
      const oldDir = typeof fwv.metadata.path === "string" ? fwv.metadata.path : "";
      await this.copyFileRow(caller.sub, fwv, fwv.version, spaceId, fwv.name, to + oldDir.slice(from.length));
    }
    const now = new Date().toISOString();
    await this.db.run("INSERT OR IGNORE INTO folders (space_id, path, created_at) VALUES (?, ?, ?)", [spaceId, to, now]);
    const folderRows = await this.db.all<{ path: string }>("SELECT path FROM folders WHERE space_id = ? AND path LIKE ?", [
      spaceId,
      `${fromPrefix}%`,
    ]);
    for (const f of folderRows) {
      await this.db.run("INSERT OR IGNORE INTO folders (space_id, path, created_at) VALUES (?, ?, ?)", [spaceId, to + f.path.slice(from.length), now]);
    }
    return { created: !destKind };
  }

  /** Insert a new file row + version pointing at an existing blob (one ref bump). */
  private async copyFileRow(
    userSub: string,
    src: FileRecord,
    version: FileVersion | null,
    spaceId: string,
    name: string,
    dir: string,
  ): Promise<void> {
    if (!version || version.source !== "blob" || !version.blobKey) throw new NotFoundError("cannot copy a file without managed content");
    if ((await this.repo.increment(version.blobKey)) == null) throw new BlobMissingError();
    const now = new Date().toISOString();
    const fileId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const metadata = { ...src.metadata, path: normPath(dir) };
    await this.db.batch([
      {
        sql: `INSERT INTO files (id, tenant_id, owner_id, name, current_version_id, metadata, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [fileId, spaceId, userSub, name, versionId, JSON.stringify(metadata), now, now],
      },
      {
        sql: `INSERT INTO file_versions (id, file_id, source, blob_hash, mime, size, created_at, created_by)
              VALUES (?, ?, 'blob', ?, ?, ?, ?, ?)`,
        params: [versionId, fileId, version.blobKey, version.mime, version.size, now, userSub],
      },
      {
        sql: `INSERT OR IGNORE INTO relation_tuples (object_type, object_id, relation, subject_type, subject_id, subject_relation)
              VALUES ('file', ?, 'owner', 'user', ?, '')`,
        params: [fileId, userSub],
      },
      {
        sql: `INSERT OR IGNORE INTO relation_tuples (object_type, object_id, relation, subject_type, subject_id, subject_relation)
              VALUES ('file', ?, 'space', 'space', ?, '')`,
        params: [fileId, spaceId],
      },
    ]);
  }

  // ── app passwords (Basic-auth tokens for WebDAV etc.) ───────────────────────
  createAppPassword(userSub: string, name: string) {
    return createAppPwd(this.db, userSub, name);
  }
  verifyAppPassword(token: string) {
    return verifyAppPwd(this.db, token);
  }
  listAppPasswords(userSub: string): Promise<AppPassword[]> {
    return listAppPwds(this.db, userSub);
  }
  deleteAppPassword(userSub: string, id: string) {
    return deleteAppPwd(this.db, userSub, id);
  }

  // ── per-user plugin settings (opaque JSON; API encrypts secret fields) ──────
  getPluginSettings(userSub: string, pluginId: string): Promise<string | null> {
    return getPluginSettings(this.db, userSub, pluginId);
  }
  setPluginSettings(userSub: string, pluginId: string, config: string): Promise<void> {
    return setPluginSettings(this.db, userSub, pluginId, config);
  }
  deletePluginSettings(userSub: string, pluginId: string): Promise<void> {
    return deletePluginSettings(this.db, userSub, pluginId);
  }

  // ── per-user installed plugin set (JSON list; null = apply server defaults) ──
  getInstalledPlugins(userSub: string): Promise<string[] | null> {
    return getInstalledPlugins(this.db, userSub);
  }
  setInstalledPlugins(userSub: string, pluginIds: string[]): Promise<void> {
    return setInstalledPlugins(this.db, userSub, pluginIds);
  }

  // ── per-user AI-generated plugins (Plugin Studio: manifest + ESM source) ─────
  listCustomPlugins(userSub: string): Promise<CustomPlugin[]> {
    return listCustomPlugins(this.db, userSub);
  }
  getCustomPlugin(userSub: string, pluginId: string): Promise<CustomPlugin | null> {
    return getCustomPlugin(this.db, userSub, pluginId);
  }
  /** Save a generated plugin and add its id to the user's installed set (so it goes active). */
  async addCustomPlugin(userSub: string, input: { id: string; manifest: string; source: string }): Promise<void> {
    await upsertCustomPlugin(this.db, userSub, input);
    const installed = (await getInstalledPlugins(this.db, userSub)) ?? [];
    if (!installed.includes(input.id)) await setInstalledPlugins(this.db, userSub, [...installed, input.id]);
  }
  /** Remove a generated plugin and drop its id from the user's installed set. */
  async removeCustomPlugin(userSub: string, pluginId: string): Promise<void> {
    await deleteCustomPlugin(this.db, userSub, pluginId);
    const installed = await getInstalledPlugins(this.db, userSub);
    if (installed?.includes(pluginId)) {
      await setInstalledPlugins(
        this.db,
        userSub,
        installed.filter((id) => id !== pluginId),
      );
    }
  }

  // ── per-space applied plugins (owner-managed; active for every member) ──────
  /** Plugins applied to a space. Requires viewer+ (any member can see what runs). */
  async spacePlugins(caller: Caller, spaceId: string): Promise<string[]> {
    await this.requireSpace(caller.sub, spaceId, "viewer");
    return getSpacePlugins(this.db, spaceId);
  }

  /** Apply a plugin to a space — turns it on for everyone in the space. Requires owner. */
  async applySpacePlugin(caller: Caller, spaceId: string, pluginId: string): Promise<void> {
    await this.requireSpace(caller.sub, spaceId, "owner");
    await applySpacePluginRow(this.db, spaceId, pluginId, caller.sub);
  }

  /** Remove a plugin from a space. Requires owner. */
  async removeSpacePlugin(caller: Caller, spaceId: string, pluginId: string): Promise<void> {
    await this.requireSpace(caller.sub, spaceId, "owner");
    await removeSpacePluginRow(this.db, spaceId, pluginId);
  }

  /** Plugin ids applied to any space the caller belongs to (union with installs is done by the API). */
  async spaceAppliedPlugins(userSub: string): Promise<string[]> {
    const spaceIds = await memberSpaceIds(this.db, userSub);
    return pluginIdsForSpaces(this.db, spaceIds);
  }

  /**
   * The places the caller can apply a plugin to — the group spaces they own —
   * each flagged with whether the plugin is currently applied there. Powers the
   * "Applies to places" picker in a plugin's settings.
   */
  async pluginPlaces(caller: Caller, pluginId: string): Promise<{ spaceId: string; name: string; applied: boolean }[]> {
    const owned = (await listSpacesForUser(this.db, caller.sub)).filter((s) => s.kind === "group" && s.role === "owner");
    const applied = await spacesWithPlugin(this.db, pluginId, owned.map((s) => s.id));
    return owned.map((s) => ({ spaceId: s.id, name: s.name, applied: applied.has(s.id) }));
  }

  /** The current version's blob key for streaming a managed download. Requires viewer+. */
  async getContentKey(caller: Caller, id: string): Promise<{ key: string; version: FileVersion }> {
    const { version } = await this.getFile(caller, id);
    if (!version) throw new NotFoundError("file has no content");
    if (version.source !== "blob" || !version.blobKey) throw new NotFoundError("not a managed blob");
    return { key: version.blobKey, version };
  }

  /**
   * Blob key for a *specific* version's content, for downloading an old version
   * from the history. Requires viewer+. Only managed-blob versions are streamable
   * today (external-source versions read through their connector — not yet wired).
   */
  async getVersionContentKey(caller: Caller, id: string, versionId: string): Promise<{ key: string; version: FileVersion }> {
    await this.requirePerm(caller, id, "viewer");
    const row = await this.db.first<VersionRow>(
      "SELECT * FROM file_versions WHERE id = ? AND file_id = ?",
      [versionId, id],
    );
    if (!row) throw new NotFoundError("version not found");
    const version = toVersion(row);
    if (version.source !== "blob" || !version.blobKey) throw new NotFoundError("not a managed blob");
    return { key: version.blobKey, version };
  }

  /** List a virtual folder within a space the caller can see, enriched for display. */
  async list(
    userSub: string,
    spaceId: string,
    dir = "",
  ): Promise<{ path: string; spaceName: string; files: ListedFile[]; folders: string[] }> {
    await this.requirePath(userSub, spaceId, dir, "viewer");
    const path = normPath(dir);
    const rows = await this.db.all<JoinedRow>(
      `SELECT f.*, ${VERSION_COLS}
       FROM files f LEFT JOIN file_versions v ON v.id = f.current_version_id
       WHERE f.tenant_id = ? AND f.deleted_at IS NULL AND json_extract(f.metadata, '$.path') = ?
       ORDER BY f.name`,
      [spaceId, path],
    );
    const pathRows = await this.db.all<{ p: string | null }>(
      `SELECT DISTINCT json_extract(metadata, '$.path') AS p FROM files WHERE tenant_id = ? AND deleted_at IS NULL`,
      [spaceId],
    );
    // Empty folders are explicit rows; non-empty ones are derived from file paths.
    const folderRows = await this.db.all<{ path: string }>("SELECT path FROM folders WHERE space_id = ?", [spaceId]);
    const allPaths = [...pathRows.map((r) => r.p ?? ""), ...folderRows.map((r) => r.path)];

    const items = rows.map(joinedToFileWithVersion);
    const files = await this.enrichForDisplay(items);
    const space = await getSpace(this.db, spaceId);
    return { path, spaceName: space?.name ?? "My Drive", files, folders: subfolders(path, allPaths) };
  }

  /** Attach `sharedWith` labels + an `ownerLabel` to listed files (batched lookups). */
  private async enrichForDisplay(items: FileWithVersion[]): Promise<ListedFile[]> {
    if (items.length === 0) return [];
    const ids = items.map((f) => f.id);
    const grants = await this.db.all<{ object_id: string; subject_type: string; subject_id: string }>(
      `SELECT object_id, subject_type, subject_id FROM relation_tuples
       WHERE object_type = 'file' AND relation IN ('owner','editor','viewer')
         AND object_id IN (${ids.map(() => "?").join(",")})`,
      ids,
    );
    const userSubs = new Set([...items.map((f) => f.ownerId), ...grants.filter((g) => g.subject_type === "user").map((g) => g.subject_id)]);
    const spaceIds = new Set(grants.filter((g) => g.subject_type === "space").map((g) => g.subject_id));
    const users = userSubs.size
      ? await this.db.all<{ sub: string; email: string | null; name: string | null }>(
          `SELECT sub, email, name FROM users WHERE sub IN (${[...userSubs].map(() => "?").join(",")})`,
          [...userSubs],
        )
      : [];
    const spaceRows = spaceIds.size
      ? await this.db.all<{ id: string; name: string }>(
          `SELECT id, name FROM spaces WHERE id IN (${[...spaceIds].map(() => "?").join(",")})`,
          [...spaceIds],
        )
      : [];
    const userLabel = (sub: string) => {
      const u = users.find((x) => x.sub === sub);
      return u?.name || u?.email || sub;
    };
    const labelFor = (g: { subject_type: string; subject_id: string }) =>
      g.subject_type === "email" ? g.subject_id : g.subject_type === "space" ? (spaceRows.find((s) => s.id === g.subject_id)?.name ?? "a space") : userLabel(g.subject_id);

    const byFile = new Map<string, string[]>();
    for (const g of grants) {
      const file = items.find((f) => f.id === g.object_id)!;
      if (g.subject_type === "user" && g.subject_id === file.ownerId) continue; // skip the owner's own grant
      const arr = byFile.get(g.object_id) ?? [];
      const label = labelFor(g);
      if (!arr.includes(label)) arr.push(label);
      byFile.set(g.object_id, arr);
    }
    return items.map((f) => ({ ...f, sharedWith: byFile.get(f.id) ?? [], ownerLabel: userLabel(f.ownerId) }));
  }

  /**
   * Recent processor runs across every space the caller can see, newest first —
   * the aggregate read behind a plugin's activity view. Flattens each file's
   * `metadata.processing` log; optionally filtered to one plugin id.
   */
  async recentProcessing(userSub: string, opts?: { plugin?: string; limit?: number }): Promise<ProcessingRun[]> {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    const spaces = await listSpacesForUser(this.db, userSub);
    if (spaces.length === 0) return [];
    const ids = spaces.map((s) => s.id);
    const ph = ids.map(() => "?").join(",");
    // Only files whose processing log is a non-empty array; recent files first.
    const rows = await this.db.all<{ id: string; name: string; tenant_id: string; metadata: string }>(
      `SELECT id, name, tenant_id, metadata FROM files
         WHERE tenant_id IN (${ph}) AND deleted_at IS NULL
           AND json_array_length(json_extract(metadata, '$.processing')) > 0
         ORDER BY updated_at DESC
         LIMIT ?`,
      [...ids, limit],
    );
    const nameOf = new Map(spaces.map((s) => [s.id, s.name]));
    const runs: ProcessingRun[] = [];
    for (const r of rows) {
      const meta = parseMeta(r.metadata);
      const entries = Array.isArray(meta.processing) ? (meta.processing as Record<string, unknown>[]) : [];
      for (const e of entries) {
        if (opts?.plugin && e.plugin !== opts.plugin) continue;
        runs.push({
          fileId: r.id,
          fileName: r.name,
          spaceName: nameOf.get(r.tenant_id) ?? "",
          at: typeof e.at === "string" ? e.at : "",
          plugin: typeof e.plugin === "string" ? e.plugin : "",
          status: e.status === "error" ? "error" : "ok",
          model: typeof e.model === "string" ? e.model : undefined,
          labels: Array.isArray(e.labels) ? (e.labels as string[]) : undefined,
          described: e.described === true,
          note: typeof e.note === "string" ? e.note : undefined,
        });
      }
    }
    runs.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return runs.slice(0, limit);
  }

  /** Create an (empty) folder at a virtual path. Requires editor+ on the space. */
  async createFolder(spaceId: string, userSub: string, path: string): Promise<{ path: string }> {
    await this.requirePath(userSub, spaceId, path, "editor");
    const p = normPath(path);
    if (!p) throw new NotFoundError("folder path required");
    await this.db.run("INSERT OR IGNORE INTO folders (space_id, path, created_at) VALUES (?, ?, ?)", [
      spaceId,
      p,
      new Date().toISOString(),
    ]);
    return { path: p };
  }

  /** Lightweight stats for a space (file count + bytes used). Requires viewer+. */
  async overview(userSub: string, spaceId: string): Promise<{ files: number; bytes: number }> {
    await this.requireSpace(userSub, spaceId, "viewer");
    const row = await this.db.first<{ files: number; bytes: number }>(
      `SELECT COUNT(*) AS files, COALESCE(SUM(v.size), 0) AS bytes
       FROM files f LEFT JOIN file_versions v ON v.id = f.current_version_id
       WHERE f.tenant_id = ? AND f.deleted_at IS NULL`,
      [spaceId],
    );
    return { files: row?.files ?? 0, bytes: row?.bytes ?? 0 };
  }

  /** Files shared directly with the caller that live outside their own spaces. */
  async listSharedWithMe(userSub: string): Promise<ListedFile[]> {
    const mine = await memberSpaceIds(this.db, userSub);
    const notIn = mine.length ? `AND f.tenant_id NOT IN (${mine.map(() => "?").join(",")})` : "";
    const rows = await this.db.all<JoinedRow>(
      `SELECT f.*, ${VERSION_COLS}
       FROM files f
       JOIN relation_tuples t ON t.object_type = 'file' AND t.object_id = f.id
         AND t.subject_type = 'user' AND t.subject_id = ? AND t.relation IN ('owner','editor','viewer')
       LEFT JOIN file_versions v ON v.id = f.current_version_id
       WHERE f.deleted_at IS NULL ${notIn}
       GROUP BY f.id ORDER BY f.name`,
      [userSub, ...mine],
    );
    return this.enrichForDisplay(rows.map(joinedToFileWithVersion));
  }

  /** Merge into the metadata JSON. Does NOT create a new version. Requires editor+. */
  async patchMetadata(caller: Caller, id: string, patch: Record<string, unknown>): Promise<FileWithVersion> {
    const file = await this.requirePerm(caller, id, "editor");
    const metadata = { ...file.metadata, ...patch };
    if ("path" in patch) metadata.path = normPath(String(patch.path ?? ""));
    await this.db.run("UPDATE files SET metadata = ?, updated_at = ? WHERE id = ?", [
      JSON.stringify(metadata),
      new Date().toISOString(),
      id,
    ]);
    return this.getFile(caller, id);
  }

  /**
   * Add a new version (new content) without touching metadata. Requires editor+.
   *
   * Successive saves by the same author within the coalesce window collapse into
   * the current version instead of appending a new row — see
   * {@link DEFAULT_COALESCE_WINDOW_MS}. The blob the version pointed at is released
   * (removed if nothing else references it), so coalescing never grows storage.
   */
  async addVersion(
    caller: Caller,
    id: string,
    input: { hash: string; mime?: string; coalesce?: boolean },
  ): Promise<FileWithVersion> {
    const file = await this.requirePerm(caller, id, "editor");
    const key = this.keyFor(file.tenantId, input.hash); // blob lives in the file's space
    const blob = await this.repo.find(key);
    if (!blob) throw new BlobMissingError();
    const now = new Date().toISOString();

    const head = file.currentVersionId
      ? await this.db.first<VersionRow>("SELECT * FROM file_versions WHERE id = ?", [file.currentVersionId])
      : null;
    const windowMs = this.opts.versionCoalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
    // An explicit Save (`coalesce: false`) always appends a discrete version;
    // programmatic re-writes (WebDAV, autosave) still collapse within the window.
    const coalesce =
      input.coalesce !== false &&
      !!head &&
      head.source === "blob" &&
      head.created_by === caller.sub &&
      Date.now() - new Date(head.created_at).getTime() < windowMs;

    if (coalesce && head) {
      // Replace the current version's content in place; keep its id + created_at
      // (the window anchor) so the history shows one entry per editing session.
      await this.db.batch([
        { sql: "UPDATE file_versions SET blob_hash = ?, mime = ?, size = ? WHERE id = ?", params: [key, input.mime ?? null, blob.size, head.id] },
        { sql: "UPDATE files SET updated_at = ? WHERE id = ?", params: [now, id] },
      ]);
      // Balance refcounts: drop the superseded content, or — if the same bytes were
      // re-saved — the extra ref the upload step reserved for a row we didn't add.
      if (head.blob_hash) await releaseBlob(this.repo, this.store, head.blob_hash);
      return this.getFile(caller, id);
    }

    const versionId = crypto.randomUUID();
    await this.db.batch([
      {
        sql: `INSERT INTO file_versions (id, file_id, source, blob_hash, mime, size, created_at, created_by)
              VALUES (?, ?, 'blob', ?, ?, ?, ?, ?)`,
        params: [versionId, id, key, input.mime ?? null, blob.size, now, caller.sub],
      },
      { sql: "UPDATE files SET current_version_id = ?, updated_at = ? WHERE id = ?", params: [versionId, now, id] },
    ]);
    return this.getFile(caller, id);
  }

  /** A file's version history, newest first, each labelled with who created it. Requires viewer+. */
  async listVersions(caller: Caller, id: string): Promise<VersionEntry[]> {
    await this.requirePerm(caller, id, "viewer");
    const rows = await this.db.all<VersionRow>(
      "SELECT * FROM file_versions WHERE file_id = ? ORDER BY created_at DESC, rowid DESC",
      [id],
    );
    const versions = rows.map(toVersion);
    const subs = [...new Set(versions.map((v) => v.createdBy))];
    const users = subs.length
      ? await this.db.all<{ sub: string; email: string | null; name: string | null }>(
          `SELECT sub, email, name FROM users WHERE sub IN (${subs.map(() => "?").join(",")})`,
          subs,
        )
      : [];
    const label = (sub: string) => {
      const u = users.find((x) => x.sub === sub);
      return u?.name || u?.email || sub;
    };
    return versions.map((v) => ({ ...v, createdByLabel: label(v.createdBy) }));
  }

  /**
   * Restore an older version by making its content the current version. Requires
   * editor+. Non-destructive: appends a new version pointing at the old content
   * (so the restore is itself a history entry) and never coalesces.
   */
  async restoreVersion(caller: Caller, id: string, versionId: string): Promise<FileWithVersion> {
    const file = await this.requirePerm(caller, id, "editor");
    if (file.currentVersionId === versionId) return this.getFile(caller, id);
    const target = await this.db.first<VersionRow>(
      "SELECT * FROM file_versions WHERE id = ? AND file_id = ?",
      [versionId, id],
    );
    if (!target) throw new NotFoundError("version not found");
    if (target.source !== "blob" || !target.blob_hash) throw new NotFoundError("cannot restore a non-blob version");
    // A new row references the same blob, so take a ref (fails if it was GC'd).
    if ((await this.repo.increment(target.blob_hash)) == null) throw new BlobMissingError();
    const now = new Date().toISOString();
    const newId = crypto.randomUUID();
    await this.db.batch([
      {
        sql: `INSERT INTO file_versions (id, file_id, source, blob_hash, mime, size, created_at, created_by)
              VALUES (?, ?, 'blob', ?, ?, ?, ?, ?)`,
        params: [newId, id, target.blob_hash, target.mime, target.size, now, caller.sub],
      },
      { sql: "UPDATE files SET current_version_id = ?, updated_at = ? WHERE id = ?", params: [newId, now, id] },
    ]);
    return this.getFile(caller, id);
  }

  /**
   * Pin (or unpin) a version so retention/pruning never removes it (#11). Requires
   * editor+. The current version is always retained regardless of this flag.
   */
  async keepVersion(caller: Caller, id: string, versionId: string, keep: boolean): Promise<void> {
    await this.requirePerm(caller, id, "editor");
    const res = await this.db.run("UPDATE file_versions SET keep = ? WHERE id = ? AND file_id = ?", [
      keep ? 1 : 0,
      versionId,
      id,
    ]);
    if (res.rowsAffected === 0) throw new NotFoundError("version not found");
  }

  /**
   * Thin one file's version history down to the tiered retention curve (see
   * {@link versionsToPrune}), deleting the dropped `file_versions` rows and releasing
   * their blob refs (shared blobs survive via refcount). The current and pinned
   * versions are always kept. A maintenance op — runs from the scheduler, not a user
   * request — so it takes no caller and does no permission check. Returns the count pruned.
   */
  async pruneFileVersions(fileId: string, nowMs = Date.now()): Promise<number> {
    const file = await this.loadFile(fileId, true);
    if (!file) return 0;
    const rows = await this.db.all<VersionRow>("SELECT * FROM file_versions WHERE file_id = ?", [fileId]);
    if (rows.length <= 1) return 0;
    const ids = versionsToPrune(
      rows.map((r) => ({
        id: r.id,
        createdAtMs: new Date(r.created_at).getTime(),
        keep: r.keep === 1,
        isCurrent: r.id === file.currentVersionId,
      })),
      nowMs,
    );
    if (!ids.length) return 0;
    const idSet = new Set(ids);
    const toRelease = rows.filter((r) => idSet.has(r.id) && r.blob_hash).map((r) => r.blob_hash!);
    await this.db.batch(ids.map((vid) => ({ sql: "DELETE FROM file_versions WHERE id = ?", params: [vid] })));
    for (const h of toRelease) await releaseBlob(this.repo, this.store, h);
    return ids.length;
  }

  /**
   * Sweep every file that has more than one version and apply {@link pruneFileVersions}.
   * The scheduler's entry point (Cloudflare Cron / Node interval). Returns how many
   * files were examined and how many versions were pruned in total.
   */
  async pruneAllVersions(nowMs = Date.now()): Promise<{ files: number; pruned: number }> {
    const rows = await this.db.all<{ file_id: string }>(
      "SELECT file_id FROM file_versions GROUP BY file_id HAVING COUNT(*) > 1",
    );
    let pruned = 0;
    for (const { file_id } of rows) pruned += await this.pruneFileVersions(file_id, nowMs);
    return { files: rows.length, pruned };
  }

  // ── comments (a discussion thread on a file) ─────────────────────────────────

  /** A file's comments, oldest first, each labelled with who wrote it. Requires viewer+. */
  async listComments(caller: Caller, id: string): Promise<CommentEntry[]> {
    await this.requirePerm(caller, id, "viewer");
    const rows = await this.db.all<CommentRow>(
      "SELECT * FROM file_comments WHERE file_id = ? AND deleted_at IS NULL ORDER BY created_at, rowid",
      [id],
    );
    return this.labelComments(rows);
  }

  /** Post a comment. Anyone who can see the file can comment, so requires viewer+. */
  async addComment(caller: Caller, id: string, body: string): Promise<CommentEntry> {
    await this.requirePerm(caller, id, "viewer");
    const text = body.trim();
    if (!text) throw new Error("comment body required");
    const now = new Date().toISOString();
    const commentId = crypto.randomUUID();
    await this.db.run(
      "INSERT INTO file_comments (id, file_id, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [commentId, id, caller.sub, text, now, now],
    );
    const [entry] = await this.labelComments([
      { id: commentId, file_id: id, author_id: caller.sub, body: text, created_at: now, updated_at: now, deleted_at: null },
    ]);
    return entry!;
  }

  /**
   * Soft-delete a comment. Allowed for its author or the file's owner (so an owner
   * can moderate the thread). Requires viewer+ on the file to even resolve it.
   */
  async deleteComment(caller: Caller, id: string, commentId: string): Promise<void> {
    await this.requirePerm(caller, id, "viewer");
    const row = await this.db.first<CommentRow>(
      "SELECT * FROM file_comments WHERE id = ? AND file_id = ? AND deleted_at IS NULL",
      [commentId, id],
    );
    if (!row) throw new NotFoundError("comment not found");
    if (row.author_id !== caller.sub) {
      const role = await fileRole(this.db, id, caller.sub, caller.email ?? "");
      if (role !== "owner") throw new PermissionError("only the author or file owner can delete a comment");
    }
    await this.db.run("UPDATE file_comments SET deleted_at = ? WHERE id = ?", [new Date().toISOString(), commentId]);
  }

  /** Resolve author subs → friendly labels for a batch of comment rows. */
  private async labelComments(rows: CommentRow[]): Promise<CommentEntry[]> {
    if (rows.length === 0) return [];
    const subs = [...new Set(rows.map((r) => r.author_id))];
    const users = await this.db.all<{ sub: string; email: string | null; name: string | null }>(
      `SELECT sub, email, name FROM users WHERE sub IN (${subs.map(() => "?").join(",")})`,
      subs,
    );
    const label = (sub: string) => {
      const u = users.find((x) => x.sub === sub);
      return u?.name || u?.email || sub;
    };
    return rows.map((r) => ({
      id: r.id,
      authorId: r.author_id,
      authorLabel: label(r.author_id),
      body: r.body,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Move the file to Trash: mark it `deleted_at` but keep its versions + blobs so
   * it can be {@link restoreFile restored}. Hidden from listings (which filter
   * `deleted_at IS NULL`). Use {@link purgeFile} to free the content. Requires owner.
   */
  async deleteFile(caller: Caller, id: string): Promise<void> {
    await this.requirePerm(caller, id, "owner");
    const now = new Date().toISOString();
    await this.db.run("UPDATE files SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
  }

  /** Files in the caller's Trash (deleted but recoverable), across their spaces. Most recently deleted first. */
  async listTrash(userSub: string): Promise<ListedFile[]> {
    const mine = await memberSpaceIds(this.db, userSub);
    if (!mine.length) return [];
    const rows = await this.db.all<JoinedRow>(
      `SELECT f.*, ${VERSION_COLS}
       FROM files f LEFT JOIN file_versions v ON v.id = f.current_version_id
       WHERE f.deleted_at IS NOT NULL AND f.tenant_id IN (${mine.map(() => "?").join(",")})
       ORDER BY f.deleted_at DESC`,
      mine,
    );
    return this.enrichForDisplay(rows.map(joinedToFileWithVersion));
  }

  /** Restore a file from Trash (clears `deleted_at`), making it visible again. Requires owner. */
  async restoreFile(caller: Caller, id: string): Promise<void> {
    await this.requirePerm(caller, id, "owner", true);
    await this.db.run("UPDATE files SET deleted_at = NULL, updated_at = ? WHERE id = ?", [
      new Date().toISOString(),
      id,
    ]);
  }

  /**
   * Permanently delete a file: drop its version rows + access grants, then release
   * each blob ref (the blob is removed once no file references it). Irreversible.
   * Requires owner.
   */
  async purgeFile(caller: Caller, id: string): Promise<void> {
    await this.requirePerm(caller, id, "owner", true);
    const versions = await this.db.all<{ blob_hash: string | null }>(
      "SELECT blob_hash FROM file_versions WHERE file_id = ? AND blob_hash IS NOT NULL",
      [id],
    );
    await this.db.batch([
      { sql: "DELETE FROM file_versions WHERE file_id = ?", params: [id] },
      { sql: "DELETE FROM relation_tuples WHERE object_type = 'file' AND object_id = ?", params: [id] },
      { sql: "DELETE FROM files WHERE id = ?", params: [id] },
    ]);
    for (const v of versions) if (v.blob_hash) await releaseBlob(this.repo, this.store, v.blob_hash);
  }

  // ── sharing (per-file grants) ───────────────────────────────────────────────

  /** Grant a principal a role on a file. Requires owner. `space` subjects target `#member`. */
  async shareGrant(
    caller: Caller,
    fileId: string,
    grant: { subjectType: SubjectType; subjectId: string; role: Role; subjectRelation?: string },
  ): Promise<void> {
    await this.requirePerm(caller, fileId, "owner");
    await writeTuple(this.db, {
      objectType: "file",
      objectId: fileId,
      relation: grant.role,
      subjectType: grant.subjectType,
      subjectId: grant.subjectType === "email" ? normalizeEmail(grant.subjectId) : grant.subjectId,
      subjectRelation: grant.subjectType === "space" ? (grant.subjectRelation ?? "member") : "",
    });
  }

  /** Revoke a specific grant. Requires owner. */
  async unshareGrant(
    caller: Caller,
    fileId: string,
    grant: { subjectType: SubjectType; subjectId: string; role: Role; subjectRelation?: string },
  ): Promise<void> {
    await this.requirePerm(caller, fileId, "owner");
    await deleteTuple(this.db, {
      objectType: "file",
      objectId: fileId,
      relation: grant.role,
      subjectType: grant.subjectType,
      subjectId: grant.subjectType === "email" ? normalizeEmail(grant.subjectId) : grant.subjectId,
      subjectRelation: grant.subjectType === "space" ? (grant.subjectRelation ?? "member") : "",
    });
  }

  /** All grants on a file, with subject names/emails resolved (for a Share dialog). Requires viewer+. */
  async listGrants(caller: Caller, fileId: string): Promise<GrantDetail[]> {
    await this.requirePerm(caller, fileId, "viewer");
    return fileGrantsDetailed(this.db, fileId);
  }

  // ── folder grants (share a folder + its subtree with a user/email/place) ─────

  /** Grant a principal a role on a folder and everything under it. Capped by the caller's own role there. */
  async shareFolderGrant(
    caller: Caller,
    spaceId: string,
    path: string,
    grant: { subjectType: SubjectType; subjectId: string; role: Role; subjectRelation?: string },
  ): Promise<void> {
    const p = normPath(path);
    if (!p) throw new PermissionError("cannot share the space root as a folder");
    await this.requirePath(caller.sub, spaceId, p, grant.role, caller.email);
    await writeTuple(this.db, {
      objectType: "folder",
      objectId: folderObjectId(spaceId, p),
      relation: grant.role,
      subjectType: grant.subjectType,
      subjectId: grant.subjectType === "email" ? normalizeEmail(grant.subjectId) : grant.subjectId,
      subjectRelation: grant.subjectType === "space" ? (grant.subjectRelation ?? "member") : "",
    });
  }

  /** Revoke a folder grant. Requires editor+ on the folder. */
  async unshareFolderGrant(
    caller: Caller,
    spaceId: string,
    path: string,
    grant: { subjectType: SubjectType; subjectId: string; role: Role; subjectRelation?: string },
  ): Promise<void> {
    const p = normPath(path);
    await this.requirePath(caller.sub, spaceId, p, "editor", caller.email);
    await deleteTuple(this.db, {
      objectType: "folder",
      objectId: folderObjectId(spaceId, p),
      relation: grant.role,
      subjectType: grant.subjectType,
      subjectId: grant.subjectType === "email" ? normalizeEmail(grant.subjectId) : grant.subjectId,
      subjectRelation: grant.subjectType === "space" ? (grant.subjectRelation ?? "member") : "",
    });
  }

  /** Grants on a folder, subject names/emails resolved (for the Share dialog). Requires viewer+. */
  async listFolderGrants(caller: Caller, spaceId: string, path: string): Promise<GrantDetail[]> {
    const p = normPath(path);
    await this.requirePath(caller.sub, spaceId, p, "viewer", caller.email);
    return folderGrantsDetailed(this.db, spaceId, p);
  }

  /** Folders shared with the caller (direct or via a place) — for "Shared with me". */
  listSharedFolders(userSub: string): Promise<{ spaceId: string; path: string; role: Role }[]> {
    return sharedFolders(this.db, userSub);
  }

  // ── share links (unguessable secret → scoped capability; see shares.ts) ──────

  /**
   * Mint a share link on a file/folder/space. The link's `role` is capped by the
   * caller's own role on the target — a viewer can't mint a read-write link.
   * Returns the plaintext secret once. The capability runs as the caller.
   */
  async createShare(caller: Caller, target: ShareFilter, opts: { role: Role; label?: string | null; expiresAt?: string | null }) {
    if (target.objectType === "file") {
      const file = await this.requirePerm(caller, target.fileId, opts.role);
      return createShareRow(this.db, caller.sub, {
        objectType: "file",
        spaceId: file.tenantId,
        fileId: target.fileId,
        role: opts.role,
        label: opts.label,
        expiresAt: opts.expiresAt,
      });
    }
    const spaceId = target.spaceId;
    await this.requireSpace(caller.sub, spaceId, opts.role);
    return createShareRow(this.db, caller.sub, {
      objectType: target.objectType,
      spaceId,
      path: target.objectType === "folder" ? normPath(target.path) : "",
      role: opts.role,
      label: opts.label,
      expiresAt: opts.expiresAt,
    });
  }

  /** Active share links on a file/folder/space (secrets stripped). Requires viewer+. */
  async listShares(caller: Caller, target: ShareFilter): Promise<ShareInfo[]> {
    if (target.objectType === "file") {
      await this.requirePerm(caller, target.fileId, "viewer");
      return listShareRows(this.db, target);
    }
    await this.requireSpace(caller.sub, target.spaceId, "viewer");
    return listShareRows(this.db, target.objectType === "folder" ? { ...target, path: normPath(target.path) } : target);
  }

  /** Revoke a share link. Allowed for its creator or anyone with editor+ on the target. */
  async revokeShare(caller: Caller, id: string): Promise<void> {
    const share = await getShareRow(this.db, id);
    if (!share) throw new NotFoundError();
    if (share.createdBy !== caller.sub) {
      if (share.objectType === "file" && share.fileId) await this.requirePerm(caller, share.fileId, "editor");
      else await this.requireSpace(caller.sub, share.spaceId, "editor");
    }
    await revokeShareRow(this.db, id);
  }

  /** Resolve a share secret to its capability (no auth — this *is* the auth). For WebDAV / `/s`. */
  verifyShare(secret: string): Promise<VerifiedShare | null> {
    return verifyShareRow(this.db, secret);
  }

  /**
   * People the caller is connected to (space co-members + file-share peers),
   * optionally filtered by `q` — for the share-with picker. Viewer-level: it
   * only surfaces the caller's own contact graph.
   */
  async connectedPeople(caller: Caller, q?: string): Promise<User[]> {
    const spaceIds = await memberSpaceIds(this.db, caller.sub);
    return connectedUsers(this.db, caller.sub, spaceIds, q);
  }

  // ── authorization ──────────────────────────────────────────────────────────

  private async requirePerm(caller: Caller, id: string, required: Role, includeDeleted = false): Promise<FileRecord> {
    const file = await this.loadFile(id, includeDeleted);
    if (!file) throw new NotFoundError();
    // Effective role = the file's own grants ∪ any folder grant covering the
    // folder it lives in (folder shares grant their whole subtree).
    const folderPath = (file.metadata.path as string) || "";
    const [fr, fo] = await Promise.all([
      fileRole(this.db, id, caller.sub, caller.email ?? ""),
      folderPath ? folderRole(this.db, file.tenantId, folderPath, caller.sub, caller.email ?? "") : Promise.resolve(null),
    ]);
    const role = maxRole(fr, fo);
    if (!role || ROLE_RANK[role] < ROLE_RANK[required]) throw new PermissionError();
    return file;
  }

  // Gate a path-based op: space membership ∪ a folder grant covering the path.
  private async requirePath(userSub: string, spaceId: string, path: string, required: Role, email = ""): Promise<void> {
    const role = await pathRole(this.db, spaceId, normPath(path), userSub, email);
    if (!role || ROLE_RANK[role] < ROLE_RANK[required]) throw new PermissionError();
  }

  private async requireSpace(userSub: string, spaceId: string, required: Role): Promise<void> {
    const role = await spaceRole(this.db, spaceId, userSub);
    if (!role || ROLE_RANK[role] < ROLE_RANK[required]) throw new PermissionError();
  }

  // Gate staging a blob: editor anywhere in the space — space membership ∪ any
  // folder grant. The destination is still gated separately by createFile.
  private async requireUpload(userSub: string, spaceId: string): Promise<void> {
    const [sr, fr] = await Promise.all([spaceRole(this.db, spaceId, userSub), spaceFolderRole(this.db, spaceId, userSub)]);
    const role = maxRole(sr, fr);
    if (!role || ROLE_RANK[role] < ROLE_RANK["editor"]) throw new PermissionError();
  }

  private async loadFile(id: string, includeDeleted = false): Promise<FileRecord | null> {
    const row = await this.db.first<FileRow>(
      `SELECT * FROM files WHERE id = ?${includeDeleted ? "" : " AND deleted_at IS NULL"}`,
      [id],
    );
    return row ? toFile(row) : null;
  }

  private async loadVersion(id: string): Promise<FileVersion | null> {
    const row = await this.db.first<VersionRow>("SELECT * FROM file_versions WHERE id = ?", [id]);
    return row ? toVersion(row) : null;
  }
}
