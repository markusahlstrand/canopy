import type { Db } from "./db";
import type { BlobRepo, BlobStore } from "./blob-store";
import type { FileRecord, FileVersion, FileWithVersion, Role, Space, User } from "./types";
import { blobKey, commitUpload, prepareBlob, releaseBlob, type PrepareResult } from "./blobs";
import { ROLE_RANK, deleteTuple, fileGrantsDetailed, fileRole, memberSpaceIds, spaceRole, writeTuple, type GrantDetail, type SubjectType } from "./authz";
import {
  addMember,
  createSpace as createGroupSpace,
  ensurePersonalSpace,
  getSpace,
  listMembers,
  listSpacesForUser,
  removeMember,
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
import { deletePluginSettings, getPluginSettings, setPluginSettings } from "./plugin-settings";
import { getInstalledPlugins, setInstalledPlugins } from "./plugin-installs";
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
  "v.id AS v_id, v.source, v.blob_hash, v.connector_id, v.external_key, v.etag, v.mime, v.size, v.created_by, v.created_at AS v_created_at";

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

  async prepareUpload(spaceId: string, userSub: string, hash: string): Promise<PrepareResult> {
    await this.requireSpace(userSub, spaceId, "editor");
    return prepareBlob(this.repo, this.keyFor(spaceId, hash));
  }

  async commitUpload(spaceId: string, userSub: string, hash: string, bytes: Uint8Array) {
    await this.requireSpace(userSub, spaceId, "editor");
    return commitUpload(this.repo, this.store, { key: this.keyFor(spaceId, hash), expectedHash: hash, bytes });
  }

  // ── files ────────────────────────────────────────────────────────────────

  async createFile(spaceId: string, userSub: string, input: CreateFileInput): Promise<FileWithVersion> {
    await this.requireSpace(userSub, spaceId, "editor");
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
    await this.requireSpace(userSub, spaceId, "viewer");
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

  /** List a virtual folder within a space the caller can see, enriched for display. */
  async list(
    userSub: string,
    spaceId: string,
    dir = "",
  ): Promise<{ path: string; spaceName: string; files: ListedFile[]; folders: string[] }> {
    await this.requireSpace(userSub, spaceId, "viewer");
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

  /** Create an (empty) folder at a virtual path. Requires editor+ on the space. */
  async createFolder(spaceId: string, userSub: string, path: string): Promise<{ path: string }> {
    await this.requireSpace(userSub, spaceId, "editor");
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
  async addVersion(caller: Caller, id: string, input: { hash: string; mime?: string }): Promise<FileWithVersion> {
    const file = await this.requirePerm(caller, id, "editor");
    const key = this.keyFor(file.tenantId, input.hash); // blob lives in the file's space
    const blob = await this.repo.find(key);
    if (!blob) throw new BlobMissingError();
    const now = new Date().toISOString();

    const head = file.currentVersionId
      ? await this.db.first<VersionRow>("SELECT * FROM file_versions WHERE id = ?", [file.currentVersionId])
      : null;
    const windowMs = this.opts.versionCoalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
    const coalesce =
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
    const role = await fileRole(this.db, id, caller.sub, caller.email ?? "");
    if (!role || ROLE_RANK[role] < ROLE_RANK[required]) throw new PermissionError();
    return file;
  }

  private async requireSpace(userSub: string, spaceId: string, required: Role): Promise<void> {
    const role = await spaceRole(this.db, spaceId, userSub);
    if (!role || ROLE_RANK[role] < ROLE_RANK[required]) throw new PermissionError();
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
