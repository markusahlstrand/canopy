import type { Db } from "./db";
import type { BlobRepo, BlobStore } from "./blob-store";
import type { FileRecord, FileVersion, FileWithVersion, Role, Space, User, VersionPolicyKind } from "./types";
import { type MirrorChange, normPath, subfolders } from "@canopy/mirror";
import { blobKey, commitUpload, prepareBlob, releaseBlob, type PrepareResult } from "./blobs";
import { versionsToPrune, type RetentionPolicy } from "./retention";
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
  connectorSpaceId,
  createSpace as createGroupSpace,
  ensureConnectorSpace,
  ensurePersonalSpace,
  getSpace,
  getVersionPolicy,
  setVersionPolicy,
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
import { listMcpClients as listMcpClientRows, recordMcpClient as recordMcpClientRow, type McpClient } from "./mcp-clients";
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

// `normPath` / `subfolders` (the virtual-folder path helpers) now live in
// `@canopy/mirror` so the browser metadata mirror derives folders with the exact
// same code the server does. Re-exported here to keep `@canopy/store`'s API stable.
export { normPath, subfolders } from "@canopy/mirror";

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
  content_ref: string | null;
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
    contentRef: r.content_ref,
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

/**
 * D1 caps bound parameters per statement (~100), so an `IN (?,?,…)` over many ids
 * (a large folder's files) overflows with "too many SQL variables". Run the query in
 * param-sized chunks and concatenate the rows. `size` stays safely under the cap.
 */
const SQL_IN_CHUNK = 90;
async function inChunks<T>(ids: string[], run: (slice: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += SQL_IN_CHUNK) out.push(...(await run(ids.slice(i, i + SQL_IN_CHUNK))));
  return out;
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
          content_ref: null, // not joined for listings; only the extract queue reads it
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
 * The slice of a `SearchIndex` the drive feeds and queries. Structural (not the
 * `@canopy/core` type) so the store stays core-independent — `createSqlSearchIndex`
 * satisfies it. The drive feeds docs in on every file mutation and queries them
 * scoped to the caller's readable spaces.
 */
export interface DriveSearchIndex {
  upsert(docs: SearchFeedDoc | SearchFeedDoc[]): Promise<void>;
  delete(ids: string | string[]): Promise<void>;
  query(
    query: { text: string; kinds?: string[]; filter?: Record<string, unknown>; limit?: number; cursor?: string },
    scope: { spaceIds: string[] },
  ): Promise<{ items: DriveSearchHit[]; cursor?: string }>;
}
export interface SearchFeedDoc {
  id: string;
  spaceId: string;
  title: string;
  text?: string;
  kind?: string;
  path?: string;
  connectorId?: string;
  modifiedAt?: string;
  metadata?: Record<string, unknown>;
}
export interface DriveSearchHit {
  id: string;
  spaceId: string;
  score: number;
  title: string;
  snippet?: string;
  kind?: string;
  path?: string;
  modifiedAt?: string;
}

/** Cap on the body bytes we read for indexing — keeps a huge file from blocking a write. */
const INDEX_MAX_TEXT_BYTES = 512 * 1024;

/** Whether a file's bytes are worth decoding as text to index (markdown, plain text, code, structured). */
function isTextLike(name: string, mime?: string | null): boolean {
  if (mime && (mime.startsWith("text/") || /(json|xml|yaml|markdown|javascript|typescript|csv|html|svg)/i.test(mime))) {
    return true;
  }
  return /\.(md|markdown|txt|text|csv|tsv|json|ya?ml|toml|ini|cfg|log|html?|xml|svg|js|jsx|ts|tsx|css|scss|less|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|sh|bash|sql|php)$/i.test(name);
}

/** Read up to `cap` bytes of a stream and decode as UTF-8 (lossy) — for indexing only. */
async function readCappedText(stream: ReadableStream<Uint8Array>, cap: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(Math.min(total, cap));
  let off = 0;
  for (const c of chunks) {
    if (off >= buf.byteLength) break;
    const take = Math.min(c.byteLength, buf.byteLength - off);
    buf.set(c.subarray(0, take), off);
    off += take;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Optional extractor that turns a non-text document's bytes into plain text for
 * indexing/reading (e.g. a PDF's embedded text layer). Injected so `@canopy/store`
 * stays dependency-free — the parser implementation lives in the app.
 */
export interface DocumentTextExtractor {
  /** Whether this extractor handles the file — checked before fetching its bytes. */
  supports(name: string, mime?: string | null): boolean;
  /** Best-effort: extracted text, or undefined if nothing usable. Must not throw. */
  extract(stream: ReadableStream<Uint8Array>, name: string, mime?: string | null): Promise<string | undefined>;
}

/**
 * The structural slice of a storage connector that {@link FileService.reconcileConnectorFolder}
 * reads from — kept here (not imported from `@canopy/core`) so the store stays
 * core-independent, the same way {@link DocumentTextExtractor} is. The real
 * `StorageConnector` satisfies it.
 */
export interface ConnectorEntry {
  /** Connector-relative POSIX path, e.g. "photos/2026/img.heic". */
  path: string;
  name: string;
  kind: "file" | "folder";
  size?: number;
  modifiedAt?: string;
  /** The backend's own creation time, when it exposes one (e.g. Synology `crtime`). */
  createdAt?: string;
  /** A change signal — for connectors without one, the host synthesizes `${size}:${mtime}`. */
  etag?: string;
  contentType?: string;
}
export interface ConnectorChange {
  type: "created" | "updated" | "deleted";
  path: string;
  entry?: ConnectorEntry;
}
export interface ReconcileConnector {
  list(path: string, opts?: { cursor?: string; limit?: number }): Promise<{ items: ConnectorEntry[]; cursor?: string }>;
  /** Optional change feed (e.g. Synology's `SYNO.FileStation.Search` over `mtime`)
   *  used to keep the index fresh incrementally; the sweep falls back to a crawl. */
  changes?(cursor?: string): AsyncIterable<ConnectorChange>;
}

/** Connector entries we never index — Synology's per-folder metadata + recycle/snapshot bins. */
const CONNECTOR_IGNORE = new Set(["@eaDir", "#recycle", "#snapshot"]);

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
    private readonly opts: {
      globalDedup?: boolean;
      versionCoalesceWindowMs?: number;
      index?: DriveSearchIndex;
      textExtractor?: DocumentTextExtractor;
      /**
       * Streams the bytes of an `external` (connector-backed) version — the host
       * builds the right {@link StorageConnector} for the file's owner + plugin
       * (the edge container path included) and reads its `external_key`. Injected
       * so `@canopy/store` stays free of connector/decryption concerns; absent in
       * pure-blob deployments. Used by {@link openContentStream} and the external
       * extract queue.
       */
      readExternal?: (version: FileVersion, file: FileRecord) => Promise<ReadableStream<Uint8Array> | null>;
      /**
       * Called after a space's change sequence advances (a file in it was created,
       * changed, or removed) — the live-sync nudge. The host wires this to the
       * per-space SSE channel (`SpaceChannel` Durable Object) so connected clients
       * pull the delta; absent on Node and pure-API deployments (polling covers
       * correctness). Best-effort: fired after the write commits, never awaited.
       */
      onSpaceChanged?: (spaceId: string, seq: number) => void;
    } = {},
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
  createSpace(
    caller: Caller,
    input: { name: string; icon?: string | null; color?: string | null },
  ): Promise<Space> {
    return createGroupSpace(this.db, {
      name: input.name,
      createdBy: caller.sub,
      icon: input.icon ?? null,
      color: input.color ?? null,
    });
  }

  /** Rename a group space. Requires owner on the space. */
  async renameSpace(caller: Caller, spaceId: string, name: string): Promise<Space> {
    await this.requireSpace(caller.sub, spaceId, "owner");
    const updated = await renameSpace(this.db, spaceId, name);
    if (!updated) throw new NotFoundError("space not found");
    return updated;
  }

  /** This space's version-retention policy. Requires viewer (anyone who can see it). */
  async spaceVersionPolicy(
    caller: Caller,
    spaceId: string,
  ): Promise<{ policy: VersionPolicyKind; days: number | null }> {
    await this.requireSpace(caller.sub, spaceId, "viewer");
    return getVersionPolicy(this.db, spaceId);
  }

  /**
   * Choose how this space retains file versions (see {@link versionsToPrune}). Owner
   * only — a connected space is owned by the user who configured the connector, so
   * they can set this for their NAS/repo even though it's read-only to writes.
   */
  async setSpaceVersionPolicy(
    caller: Caller,
    spaceId: string,
    policy: VersionPolicyKind,
    days: number | null,
  ): Promise<{ policy: VersionPolicyKind; days: number | null }> {
    await this.requireSpace(caller.sub, spaceId, "owner");
    await setVersionPolicy(this.db, spaceId, policy, policy === "days" ? days : null);
    return getVersionPolicy(this.db, spaceId);
  }

  /**
   * Permanently delete a group space and everything scoped to it: all files (with
   * their versions, comments, and per-file grants — releasing each blob ref like
   * {@link purgeFile}), explicit folders, share links, applied plugins, invite
   * links, every member's mount preference, and the space's own access tuples.
   * Irreversible. Requires owner. A personal ("My Drive") space can't be deleted.
   */
  async deleteSpace(caller: Caller, spaceId: string): Promise<void> {
    await this.requireSpace(caller.sub, spaceId, "owner");
    const space = await getSpace(this.db, spaceId);
    if (!space) throw new NotFoundError("space not found");
    if (space.kind === "personal") throw new PermissionError("a personal space can't be deleted");

    // Files (incl. trashed) live in tenant_id = spaceId; gather their blob refs to
    // release after the rows are gone.
    const files = await this.db.all<{ id: string }>("SELECT id FROM files WHERE tenant_id = ?", [spaceId]);
    const fileIds = files.map((f) => f.id);
    const blobHashes: string[] = [];
    if (fileIds.length) {
      const ph = fileIds.map(() => "?").join(",");
      const versions = await this.db.all<{ blob_hash: string | null }>(
        `SELECT blob_hash FROM file_versions WHERE file_id IN (${ph}) AND blob_hash IS NOT NULL`,
        fileIds,
      );
      for (const v of versions) if (v.blob_hash) blobHashes.push(v.blob_hash);
    }

    const stmts: { sql: string; params: unknown[] }[] = [];
    if (fileIds.length) {
      const ph = fileIds.map(() => "?").join(",");
      stmts.push(
        { sql: `DELETE FROM file_versions WHERE file_id IN (${ph})`, params: fileIds },
        { sql: `DELETE FROM file_comments WHERE file_id IN (${ph})`, params: fileIds },
        { sql: `DELETE FROM relation_tuples WHERE object_type = 'file' AND object_id IN (${ph})`, params: fileIds },
        { sql: `DELETE FROM files WHERE id IN (${ph})`, params: fileIds },
      );
    }
    stmts.push(
      { sql: "DELETE FROM folders WHERE space_id = ?", params: [spaceId] },
      { sql: "DELETE FROM shares WHERE space_id = ?", params: [spaceId] },
      { sql: "DELETE FROM space_plugins WHERE space_id = ?", params: [spaceId] },
      { sql: "DELETE FROM space_invites WHERE space_id = ?", params: [spaceId] },
      { sql: "DELETE FROM space_prefs WHERE space_id = ?", params: [spaceId] },
      { sql: "DELETE FROM relation_tuples WHERE object_type = 'space' AND object_id = ?", params: [spaceId] },
      { sql: "DELETE FROM spaces WHERE id = ?", params: [spaceId] },
    );
    await this.db.batch(stmts);

    for (const h of blobHashes) await releaseBlob(this.repo, this.store, h);
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

  // ── uploads scoped to an existing file ──────────────────────────────────────
  // Staging a blob for a file's *next version*. Gated on editor of the file
  // itself (not space-wide upload rights), so someone holding only a file/folder
  // share can save — and keyed to the file's own space, so {@link addVersion}
  // (which looks under `file.tenantId`) is guaranteed to find it. Callers that
  // upload by space can't know a shared file's space, which is how a blob ends up
  // in the wrong space and `addVersion` 409s with BlobMissing.

  async prepareFileUpload(caller: Caller, id: string, hash: string): Promise<PrepareResult> {
    const file = await this.requirePerm(caller, id, "editor");
    return prepareBlob(this.repo, this.keyFor(file.tenantId, hash));
  }

  async commitFileUpload(caller: Caller, id: string, hash: string, bytes: Uint8Array) {
    const file = await this.requirePerm(caller, id, "editor");
    return commitUpload(this.repo, this.store, { key: this.keyFor(file.tenantId, hash), expectedHash: hash, bytes });
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

    await this.reindex(fileId);
    await this.bumpSeq(spaceId, fileId);
    return (await this.getFile({ sub: userSub }, fileId))!;
  }

  /** File record + current version. Requires viewer+. */
  async getFile(caller: Caller, id: string): Promise<FileWithVersion> {
    const file = await this.requirePerm(caller, id, "viewer");
    const version = file.currentVersionId ? await this.loadVersion(file.currentVersionId) : null;
    return { ...file, version };
  }

  /** Like {@link getFile} but enriched (sharedWith + ownerLabel) to match a listing
   * item, so a single file fetched by id renders identically. Requires viewer+. */
  async getFileForDisplay(caller: Caller, id: string): Promise<ListedFile> {
    const [enriched] = await this.enrichForDisplay([await this.getFile(caller, id)]);
    return enriched!;
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
    const affected = await this.db.all<{ id: string }>(
      `SELECT id FROM files WHERE tenant_id = ? AND deleted_at IS NULL
         AND (json_extract(metadata, '$.path') = ? OR json_extract(metadata, '$.path') LIKE ?)`,
      [spaceId, p, `${prefix}%`],
    );
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
    await this.deindex(affected.map((r) => r.id));
    await this.bumpSeq(spaceId, affected.map((r) => r.id));
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
      await this.reindex(file.id);
      await this.bumpSeq(spaceId, file.id);
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
      await this.reindex(r.id);
    }
    await this.bumpSeq(spaceId, rows.map((r) => r.id));
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
    await this.reindex(fileId);
    await this.bumpSeq(spaceId, fileId);
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

  // ── MCP clients (which AI assistants connected over the remote MCP server) ──
  recordMcpClient(userSub: string, clientId: string, info?: { name?: string | null; version?: string | null }) {
    return recordMcpClientRow(this.db, userSub, clientId, info);
  }
  listMcpClients(userSub: string): Promise<McpClient[]> {
    return listMcpClientRows(this.db, userSub);
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
   * Open the bytes of a file's current version as a stream — a managed `blob` from
   * the blob store, or an `external` source via the injected `readExternal`. Does
   * NOT re-check access: callers pass a `file` they already authorized (via
   * {@link getFile}). Returns null when there's no content, the blob is missing, or
   * no external reader is wired. The unified opener behind the download route and
   * the MCP read tools, so both reach connector-backed files transparently.
   */
  async openContentStream(file: FileWithVersion): Promise<ReadableStream<Uint8Array> | null> {
    const v = file.version;
    if (!v) return null;
    if (v.source === "blob" && v.blobKey) return this.store.get(v.blobKey);
    if (v.source === "external") return this.opts.readExternal ? this.opts.readExternal(v, file) : null;
    return null;
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
    // Chunked IN: a folder can hold far more files than D1's per-query parameter cap.
    const grants = await inChunks(ids, (slice) =>
      this.db.all<{ object_id: string; subject_type: string; subject_id: string }>(
        `SELECT object_id, subject_type, subject_id FROM relation_tuples
         WHERE object_type = 'file' AND relation IN ('owner','editor','viewer')
           AND object_id IN (${slice.map(() => "?").join(",")})`,
        slice,
      ),
    );
    const userSubs = new Set([...items.map((f) => f.ownerId), ...grants.filter((g) => g.subject_type === "user").map((g) => g.subject_id)]);
    const spaceIds = new Set(grants.filter((g) => g.subject_type === "space").map((g) => g.subject_id));
    const users = await inChunks([...userSubs], (slice) =>
      this.db.all<{ sub: string; email: string | null; name: string | null }>(
        `SELECT sub, email, name FROM users WHERE sub IN (${slice.map(() => "?").join(",")})`,
        slice,
      ),
    );
    const spaceRows = await inChunks([...spaceIds], (slice) =>
      this.db.all<{ id: string; name: string }>(
        `SELECT id, name FROM spaces WHERE id IN (${slice.map(() => "?").join(",")})`,
        slice,
      ),
    );
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
    await this.reindex(id);
    await this.bumpSeq(file.tenantId, id);
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
      await this.reindex(id);
      await this.bumpSeq(file.tenantId, id);
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
    await this.reindex(id);
    await this.bumpSeq(file.tenantId, id);
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
    await this.reindex(id);
    await this.bumpSeq(file.tenantId, id);
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
  async pruneFileVersions(fileId: string, nowMs = Date.now(), policy?: RetentionPolicy): Promise<number> {
    const file = await this.loadFile(fileId, true);
    if (!file) return 0;
    const rows = await this.db.all<VersionRow>("SELECT * FROM file_versions WHERE file_id = ?", [fileId]);
    if (rows.length <= 1) return 0;
    // Resolve the owning space's policy when the caller didn't preload it (`pruneAllVersions` does).
    const effective = policy ?? (await getVersionPolicy(this.db, file.tenantId));
    const ids = versionsToPrune(
      rows.map((r) => ({
        id: r.id,
        createdAtMs: new Date(r.created_at).getTime(),
        keep: r.keep === 1,
        isCurrent: r.id === file.currentVersionId,
      })),
      nowMs,
      effective,
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
    const rows = await this.db.all<{ file_id: string; tenant_id: string }>(
      `SELECT fv.file_id AS file_id, f.tenant_id AS tenant_id
         FROM file_versions fv JOIN files f ON f.id = fv.file_id
        GROUP BY fv.file_id HAVING COUNT(*) > 1`,
    );
    // Resolve each space's policy once, not once per file (a NAS space can hold tens of
    // thousands of multi-version files all sharing one policy).
    const policies = new Map<string, RetentionPolicy>();
    let pruned = 0;
    for (const { file_id, tenant_id } of rows) {
      let policy = policies.get(tenant_id);
      if (!policy) {
        policy = await getVersionPolicy(this.db, tenant_id);
        policies.set(tenant_id, policy);
      }
      pruned += await this.pruneFileVersions(file_id, nowMs, policy);
    }
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
    const file = await this.requirePerm(caller, id, "owner");
    const now = new Date().toISOString();
    await this.db.run("UPDATE files SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
    await this.deindex(id);
    await this.bumpSeq(file.tenantId, id);
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
    const file = await this.requirePerm(caller, id, "owner", true);
    await this.db.run("UPDATE files SET deleted_at = NULL, updated_at = ? WHERE id = ?", [
      new Date().toISOString(),
      id,
    ]);
    await this.reindex(id);
    await this.bumpSeq(file.tenantId, id);
  }

  /**
   * Permanently delete a file: drop its version rows + access grants, then release
   * each blob ref (the blob is removed once no file references it). Irreversible.
   * Requires owner.
   */
  async purgeFile(caller: Caller, id: string): Promise<void> {
    const file = await this.requirePerm(caller, id, "owner", true);
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
    await this.deindex(id);
    await this.tombstone(file.tenantId, id);
  }

  // ── sharing (per-file grants) ───────────────────────────────────────────────

  /** Grant a principal a role on a file. Requires owner. `space` subjects target `#member`. */
  async shareGrant(
    caller: Caller,
    fileId: string,
    grant: { subjectType: SubjectType; subjectId: string; role: Role; subjectRelation?: string },
  ): Promise<void> {
    const file = await this.requirePerm(caller, fileId, "owner");
    await writeTuple(this.db, {
      objectType: "file",
      objectId: fileId,
      relation: grant.role,
      subjectType: grant.subjectType,
      subjectId: grant.subjectType === "email" ? normalizeEmail(grant.subjectId) : grant.subjectId,
      subjectRelation: grant.subjectType === "space" ? (grant.subjectRelation ?? "member") : "",
    });
    await this.bumpSeq(file.tenantId, fileId); // refresh the file's sharedWith in the mirror
  }

  /** Revoke a specific grant. Requires owner. */
  async unshareGrant(
    caller: Caller,
    fileId: string,
    grant: { subjectType: SubjectType; subjectId: string; role: Role; subjectRelation?: string },
  ): Promise<void> {
    const file = await this.requirePerm(caller, fileId, "owner");
    await deleteTuple(this.db, {
      objectType: "file",
      objectId: fileId,
      relation: grant.role,
      subjectType: grant.subjectType,
      subjectId: grant.subjectType === "email" ? normalizeEmail(grant.subjectId) : grant.subjectId,
      subjectRelation: grant.subjectType === "space" ? (grant.subjectRelation ?? "member") : "",
    });
    await this.bumpSeq(file.tenantId, fileId); // refresh the file's sharedWith in the mirror
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

  // ── search index (feed on change + ACL-scoped query) ────────────────────────
  // The index is a *derived* cache: every mutation re-feeds the affected file(s)
  // and deletions drop them. All feeding is best-effort — a search hiccup must
  // never fail a file operation — and a no-op when no index is configured.

  /** Re-feed a single file into the index from its current DB state. Blob bodies are
   *  extracted inline; an external file's body comes from its cached extract
   *  (`content_ref` in R2), so this never re-reads the connector — the extract queue
   *  pulls the bytes once. Title + metadata index even before the body is ready. */
  private async reindex(fileId: string): Promise<void> {
    const index = this.opts.index;
    if (!index) return;
    try {
      const file = await this.loadFile(fileId);
      if (!file) {
        await index.delete(fileId); // trashed/gone — make sure it's not searchable
        return;
      }
      const version = file.currentVersionId ? await this.loadVersion(file.currentVersionId) : null;
      let body: string | undefined;
      if (version?.source === "blob" && version.blobKey) {
        const extractor = this.opts.textExtractor;
        if (isTextLike(file.name, version.mime)) {
          const stream = await this.store.get(version.blobKey);
          if (stream) body = await readCappedText(stream, INDEX_MAX_TEXT_BYTES);
        } else if (extractor?.supports(file.name, version.mime)) {
          // Non-text doc (e.g. PDF) — pull its text layer so it's searchable too.
          const stream = await this.store.get(version.blobKey);
          if (stream) body = await extractor.extract(stream, file.name, version.mime);
        }
      } else if (version?.source === "external" && version.contentRef) {
        // The extract queue already pulled + cached this file's text in R2.
        const stream = await this.store.get(version.contentRef);
        if (stream) body = await readCappedText(stream, INDEX_MAX_TEXT_BYTES);
      }
      await this.indexFileDoc(file, body);
    } catch (err) {
      console.warn(`[search] reindex failed for ${fileId}: ${(err as Error).message}`);
    }
  }

  /** Build + upsert the search doc for a file, folding user-facing metadata
   *  (description, AI labels, tags) into the body so it's findable by those too. */
  private async indexFileDoc(file: FileRecord, body?: string): Promise<void> {
    const index = this.opts.index;
    if (!index) return;
    const meta = [
      typeof file.metadata.description === "string" ? file.metadata.description : "",
      ...asStrings(file.metadata.labels),
      ...asStrings(file.metadata.tags),
    ]
      .filter(Boolean)
      .join(" ");
    await index.upsert({
      id: file.id,
      spaceId: file.tenantId,
      title: file.name,
      text: [body, meta].filter(Boolean).join("\n") || undefined,
      kind: "file",
      path: typeof file.metadata.path === "string" ? file.metadata.path : "",
      modifiedAt: file.updatedAt,
      metadata: file.metadata,
    });
  }

  /** Drop file(s) from the index. Best-effort. */
  private async deindex(ids: string | string[]): Promise<void> {
    const index = this.opts.index;
    if (!index) return;
    try {
      await index.delete(ids);
    } catch (err) {
      console.warn(`[search] deindex failed: ${(err as Error).message}`);
    }
  }

  /**
   * Full-text search over the files the caller can read. The ACL scope is the
   * caller's member spaces (personal + any group space) — resolved here and
   * passed to the index as `SearchScope`, never taken from the query — so a
   * search can't reach a space the caller can't see.
   */
  async search(
    userSub: string,
    query: { text: string; kinds?: string[]; filter?: Record<string, unknown>; limit?: number; cursor?: string },
  ): Promise<{ items: DriveSearchHit[]; cursor?: string }> {
    const index = this.opts.index;
    if (!index) return { items: [] };
    await ensurePersonalSpace(this.db, userSub);
    const spaceIds = await memberSpaceIds(this.db, userSub);
    if (spaceIds.length === 0) return { items: [] };
    return index.query(query, { spaceIds });
  }

  /**
   * Backfill: index every live file not yet in the index (idempotent). Run once
   * at startup so files that predate the index become searchable. Returns the
   * count newly indexed.
   */
  async reindexAll(): Promise<{ indexed: number }> {
    if (!this.opts.index) return { indexed: 0 };
    const rows = await this.db.all<{ id: string }>(
      "SELECT id FROM files WHERE deleted_at IS NULL AND id NOT IN (SELECT id FROM search_index)",
    );
    for (const r of rows) await this.reindex(r.id);
    return { indexed: rows.length };
  }

  // ── offline sync (per-space change sequence + delta query) ───────────────────
  // Every mutation advances the space's `space_seq` counter and stamps the new value
  // on the changed file row(s), so the browser metadata mirror can ask "give me every
  // row with seq > N" (see `changesSince`). Paired with reindex/deindex at each write,
  // and — like the search feed — best-effort: a bump failure must never fail the write.

  /** Atomically reserve a contiguous block of `n` sequence numbers for a space and
   *  return the top of the block (so the block is `top-n+1 .. top`). One statement. */
  private async reserveSeq(spaceId: string, n: number): Promise<number> {
    const row = await this.db.first<{ seq: number }>(
      `INSERT INTO space_seq (space_id, seq) VALUES (?, ?)
         ON CONFLICT(space_id) DO UPDATE SET seq = seq + ? RETURNING seq`,
      [spaceId, n, n],
    );
    return row?.seq ?? n;
  }

  /**
   * Advance `spaceId`'s change sequence and stamp a **distinct** value on each given
   * (still-present) file row, then nudge the live channel ONCE. Works for a single
   * mutation or a bulk pass (a folder move, a connector reconcile of hundreds of
   * files) — it reserves a block of seqs up front and assigns one per row in chunked
   * batches, so it stays a handful of round-trips regardless of N and never pings the
   * live channel per file. Use for creates/updates and soft-deletes (the row survives
   * with `deleted_at` set, surfaced as a tombstone in the delta); {@link tombstone}
   * handles hard deletes where no row remains. Best-effort: a failure must never fail the write.
   */
  private async bumpSeq(spaceId: string, fileIds: string | string[]): Promise<void> {
    const ids = Array.isArray(fileIds) ? fileIds : [fileIds];
    if (!ids.length) return;
    try {
      const top = await this.reserveSeq(spaceId, ids.length);
      const base = top - ids.length; // rows get base+1 .. top — distinct, so pagination never ties
      for (let i = 0; i < ids.length; i += 100) {
        const slice = ids.slice(i, i + 100);
        await this.db.batch(slice.map((id, j) => ({ sql: "UPDATE files SET seq = ? WHERE id = ?", params: [base + i + j + 1, id] })));
      }
      this.opts.onSpaceChanged?.(spaceId, top);
    } catch (err) {
      console.warn(`[sync] bumpSeq failed for ${spaceId}: ${(err as Error).message}`);
    }
  }

  /** Record a hard delete (purge): no `files` row survives, so the change can't be a
   *  stamped row — write a `tombstones` entry with a bumped seq instead, so an offline
   *  client that missed the soft-delete still learns the file is gone. */
  private async tombstone(spaceId: string, fileId: string): Promise<void> {
    try {
      const top = await this.reserveSeq(spaceId, 1);
      await this.db.run(
        "INSERT OR REPLACE INTO tombstones (space_id, file_id, seq, deleted_at) VALUES (?, ?, ?, ?)",
        [spaceId, fileId, top, new Date().toISOString()],
      );
      this.opts.onSpaceChanged?.(spaceId, top);
    } catch (err) {
      console.warn(`[sync] tombstone failed for ${spaceId}: ${(err as Error).message}`);
    }
  }

  /**
   * Delta of file-metadata changes for the offline mirror, scoped to the spaces the
   * caller can see. ACL is resolved here from `memberSpaceIds` (the same scope `list`
   * and `search` use) — never taken from `since` — so a delta can't reach a space the
   * caller can't read.
   *
   * `since` is a per-space `{spaceId: seq}` high-water map. A space absent from it
   * **bootstraps**: every live row is returned (so a never-touched seq=0 row still
   * arrives), and its cursor becomes the space's current counter. A space present in
   * it gets only rows (and tombstones) with `seq > its value`. Results are ordered by
   * `(space, seq)` and capped by `limit`; `hasMore` tells the client to pull again.
   */
  async changesSince(
    userSub: string,
    since: Record<string, number>,
    limit = 500,
  ): Promise<{
    changes: MirrorChange[];
    cursor: Record<string, number>;
    hasMore: boolean;
    spaces: { id: string; role: string; kind: string }[];
  }> {
    await ensurePersonalSpace(this.db, userSub);
    // Every space the caller can see is mirrored — personal, group, AND connected (a
    // NAS / repo index): its rows already live in D1, so the client gets them offline
    // like any other. We scope from `memberSpaceIds` (NOT `listSpacesForUser`, which
    // hides connected spaces from the sidebar) so connected spaces are included. They
    // can be large; the client bootstraps them in the background and reconcile bumps the
    // sequence in bulk, so syncing them doesn't stall the UI.
    const ids = await memberSpaceIds(this.db, userSub);
    const kindRows = ids.length
      ? await this.db.all<{ id: string; kind: string }>(
          `SELECT id, kind FROM spaces WHERE id IN (${ids.map(() => "?").join(",")})`,
          ids,
        )
      : [];
    const kindOf = new Map(kindRows.map((r) => [r.id, r.kind]));
    // `kind` is load-bearing: the client resolves the personal drive (no explicit space
    // id) by kind === "personal", and maps a connector token to the real connected-space
    // id by kind/prefix — omit it and those views can't be served from the mirror.
    const scope: { id: string; role: string; kind: string }[] = [];
    for (const id of ids) {
      scope.push({ id, kind: kindOf.get(id) ?? "group", role: (await spaceRole(this.db, id, userSub)) ?? "viewer" });
    }
    const spaces = scope; // iterate the same set for the per-space delta below
    const cap = Math.min(Math.max(limit, 1), 1000);

    // Per space, pull live rows + tombstones above the client's seq (or all live rows
    // on bootstrap), globally ordered by (space, seq) and capped. We over-read by one
    // to detect `hasMore`, then trim — so the cursor only advances past returned rows.
    const cursor: Record<string, number> = {};
    type Row = {
      kind: "live" | "tomb";
      id: string;
      tenant_id: string;
      seq: number;
      name: string | null;
      metadata: string | null;
      updated_at: string | null;
      deleted_at: string | null;
      size: number | null;
      mime: string | null;
    };
    const all: Row[] = [];
    for (const s of spaces) {
      const bootstrap = !(s.id in since);
      const sinceSeq = since[s.id] ?? 0;
      const live = await this.db.all<Row>(
        `SELECT 'live' AS kind, f.id, f.tenant_id, f.seq, f.name, f.metadata, f.updated_at, f.deleted_at,
                v.size AS size, v.mime AS mime
           FROM files f LEFT JOIN file_versions v ON v.id = f.current_version_id
          WHERE f.tenant_id = ?
            ${bootstrap ? "AND f.deleted_at IS NULL" : "AND f.seq > ?"}
          ORDER BY f.seq, f.id
          LIMIT ?`,
        bootstrap ? [s.id, cap + 1] : [s.id, sinceSeq, cap + 1],
      );
      all.push(...live);
      if (!bootstrap) {
        const tombs = await this.db.all<Row>(
          `SELECT 'tomb' AS kind, file_id AS id, space_id AS tenant_id, seq,
                  NULL AS name, NULL AS metadata, NULL AS updated_at, NULL AS deleted_at, NULL AS size, NULL AS mime
             FROM tombstones WHERE space_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
          [s.id, sinceSeq, cap + 1],
        );
        all.push(...tombs);
      }
      // Cursor starts at the space's current counter (covers a bootstrap that returned
      // every row, and tombstone-only advances); narrowed below if we had to truncate.
      const counter = await this.db.first<{ seq: number }>("SELECT seq FROM space_seq WHERE space_id = ?", [s.id]);
      cursor[s.id] = Math.max(sinceSeq, counter?.seq ?? 0);
    }

    // Global order + cap. On truncation, resume each space exactly where this page
    // stopped: a space we emitted rows for advances to its last emitted seq; a space we
    // never reached must NOT advance — a bootstrapping one re-bootstraps next pull (drop
    // its key), a delta one stays at the client's cursor — so no change is ever skipped.
    all.sort((a, b) => (a.tenant_id === b.tenant_id ? a.seq - b.seq : a.tenant_id < b.tenant_id ? -1 : 1));
    const hasMore = all.length > cap;
    const page = hasMore ? all.slice(0, cap) : all;
    if (hasMore) {
      const emitted: Record<string, number> = {};
      for (const r of page) emitted[r.tenant_id] = Math.max(emitted[r.tenant_id] ?? 0, r.seq);
      for (const id of Object.keys(cursor)) {
        if (id in emitted) cursor[id] = emitted[id]!;
        else if (!(id in since)) delete cursor[id]; // unreached bootstrap → re-bootstrap next pull
        else cursor[id] = since[id]!; // unreached delta → leave the client's cursor untouched
      }
    }

    const changes: MirrorChange[] = page.map((r) =>
      r.kind === "tomb" || r.deleted_at
        ? { id: r.id, spaceId: r.tenant_id, seq: r.seq, deleted: true }
        : {
            id: r.id,
            spaceId: r.tenant_id,
            name: r.name ?? "",
            path: typeof parseMeta(r.metadata ?? "{}").path === "string" ? (parseMeta(r.metadata ?? "{}").path as string) : "",
            metadata: parseMeta(r.metadata ?? "{}"),
            updatedAt: r.updated_at ?? "",
            seq: r.seq,
            size: r.size,
            mime: r.mime,
          },
    );
    return { changes, cursor, hasMore, spaces: scope };
  }

  /** Prune tombstones older than `horizonDays` — an offline client gone longer than
   *  this re-bootstraps anyway, so the rows are dead weight. Runs from the scheduler. */
  async pruneTombstones(horizonDays = 30, nowMs = Date.now()): Promise<{ pruned: number }> {
    const cutoff = new Date(nowMs - horizonDays * 86_400_000).toISOString();
    const res = await this.db.run("DELETE FROM tombstones WHERE deleted_at < ?", [cutoff]);
    return { pruned: res.rowsAffected };
  }

  // ── connected-space reconcile (index a connector's tree into files) ──────────
  // A connected space is a *persisted index* over a user's backend (a NAS, a repo):
  // its files are `file_versions(source='external')` rows, so they flow through the
  // same list / search / ACL / download paths as managed files. Reconcile converges
  // one folder against the connector; the host triggers it lazily on view and from
  // the scheduled sweep. The bucket is the source of truth — these rows are derived.

  /** Ensure the user's connected space for a plugin exists (idempotent). Returns its id. */
  ensureConnectorSpace(userSub: string, pluginId: string, name: string): Promise<string> {
    return ensureConnectorSpace(this.db, userSub, pluginId, name);
  }

  /**
   * Indexing state of a user's connected space, for the sidebar's "Indexing…" hint.
   * `indexing` is true while a crawl run is `running` OR extraction is still draining
   * (versions left in `extract_state='pending'`) — the two phases the user perceives
   * as "still loading new files". `pending` counts the latter (it ticks down as the
   * queue drains; the crawl's total tree size isn't known up front, so there's no
   * honest percentage). DB-only — no connector round-trip — so it's safe to poll.
   */
  async connectorIndexStatus(
    userSub: string,
    pluginId: string,
  ): Promise<{ indexing: boolean; pending: number; lastIndexedAt: string | null }> {
    const spaceId = connectorSpaceId(userSub, pluginId);
    const running = await this.db.first<{ id: string }>(
      "SELECT id FROM index_runs WHERE connection_id = ? AND status = 'running' LIMIT 1",
      [spaceId],
    );
    const pendingRow = await this.db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM file_versions v JOIN files f ON f.id = v.file_id
        WHERE f.tenant_id = ? AND v.source = 'external' AND v.extract_state = 'pending' AND f.deleted_at IS NULL`,
      [spaceId],
    );
    const last = await this.db.first<{ finished_at: string | null }>(
      "SELECT finished_at FROM index_runs WHERE connection_id = ? AND status = 'done' ORDER BY finished_at DESC LIMIT 1",
      [spaceId],
    );
    const pending = pendingRow?.n ?? 0;
    return { indexing: !!running || pending > 0, pending, lastIndexedAt: last?.finished_at ?? null };
  }

  /**
   * Reconcile one folder of a connected space against its connector: list the
   * folder, then upsert new/changed files, rename in place (preserving the file id —
   * and so its extracted text/search row), tombstone the disappeared, and prune gone
   * subfolders. New/changed files are enqueued for text extraction
   * (`extract_state='pending'`). Excludes NAS noise (`@eaDir`, `#recycle`). Returns
   * counts. The connector list can throw — the caller decides whether to surface it.
   */
  async reconcileConnectorFolder(
    ownerSub: string,
    spaceId: string,
    pluginId: string,
    connector: ReconcileConnector,
    dir: string,
  ): Promise<{ upserted: number; tombstoned: number; folders: string[]; files: number }> {
    const path = normPath(dir);
    const now = new Date().toISOString();

    // 1. List the connector folder (paginated), dropping ignored names.
    const files: ConnectorEntry[] = [];
    const folderNames = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await connector.list(path, cursor ? { cursor } : undefined);
      for (const e of page.items) {
        if (CONNECTOR_IGNORE.has(e.name)) continue;
        if (e.kind === "folder") folderNames.add(e.name);
        else files.push(e);
      }
      cursor = page.cursor;
    } while (cursor);

    // 2. Ensure an explicit folder row per subfolder (so an empty one still shows).
    for (const name of folderNames) {
      const childPath = path ? `${path}/${name}` : name;
      await this.db.run("INSERT OR IGNORE INTO folders (space_id, path, created_at) VALUES (?, ?, ?)", [spaceId, childPath, now]);
    }

    // 3. Load persisted children (files) of this folder.
    const existing = await this.db.all<{ id: string; version_id: string; external_key: string | null; etag: string | null }>(
      `SELECT f.id, f.current_version_id AS version_id, v.external_key, v.etag
         FROM files f JOIN file_versions v ON v.id = f.current_version_id
        WHERE f.tenant_id = ? AND f.deleted_at IS NULL AND json_extract(f.metadata, '$.path') = ?`,
      [spaceId, path],
    );
    const byKey = new Map(existing.map((r) => [r.external_key ?? "", r] as const));
    const seenKeys = new Set<string>();
    const newEntries: ConnectorEntry[] = [];
    let upserted = 0;
    // Every file row this pass touched — stamped with the change sequence in one bulk
    // bump at the end (so a big folder costs a handful of round-trips + ONE live nudge,
    // not a per-file write + ping that would blow the Worker's subrequest budget).
    const changed: string[] = [];

    // 4. Match by external_key: update changed, leave unchanged, collect the new.
    for (const e of files) {
      seenKeys.add(e.path);
      const prior = byKey.get(e.path);
      if (!prior) {
        newEntries.push(e);
      } else if ((prior.etag ?? null) !== (e.etag ?? null)) {
        await this.updateExternalVersion(prior.id, prior.version_id, e, now);
        changed.push(prior.id);
        upserted++;
      }
    }

    // 5. Disappeared = persisted children whose key wasn't listed. A new entry with a
    //    matching etag is a rename (preserve the id); the rest are tombstoned.
    const disappeared = existing.filter((r) => !seenKeys.has(r.external_key ?? ""));
    const consumed = new Set<string>();
    let tombstoned = 0;
    for (const e of newEntries) {
      const sig = e.etag ?? null;
      const match = sig ? disappeared.find((d) => !consumed.has(d.id) && (d.etag ?? null) === sig) : undefined;
      if (match) {
        consumed.add(match.id);
        await this.renameExternalFile(match.id, match.version_id, e, now);
        changed.push(match.id);
      } else {
        changed.push(await this.insertExternalFile(spaceId, ownerSub, pluginId, e, path, now));
      }
      upserted++;
    }
    for (const d of disappeared) {
      if (consumed.has(d.id)) continue; // consumed by a rename above
      await this.db.run("UPDATE files SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, d.id]);
      await this.deindex(d.id);
      changed.push(d.id);
      tombstoned++;
    }

    // 6. Prune subfolders that disappeared (their files + folder rows).
    const prunedIds = await this.pruneGoneSubfolders(spaceId, path, folderNames, now);
    changed.push(...prunedIds);
    tombstoned += prunedIds.length;

    // 7. One bulk sequence bump for everything that changed → the mirror's delta picks
    //    it up, and the live channel is nudged exactly once for the whole reconcile.
    await this.bumpSeq(spaceId, changed);

    const folders = [...folderNames].map((name) => (path ? `${path}/${name}` : name));
    return { upserted, tombstoned, folders, files: files.length };
  }

  /** Whether an external entry's text should be extracted (queued) or skipped. */
  private externalExtractState(e: ConnectorEntry): "pending" | "skip" {
    const extractable = isTextLike(e.name, e.contentType) || (this.opts.textExtractor?.supports(e.name, e.contentType) ?? false);
    return extractable ? "pending" : "skip";
  }

  /** Insert a new external file (files row + external version + ACL tuples), then index
   *  it by name. Returns the new file id so the reconcile can bulk-stamp its sequence. */
  private async insertExternalFile(
    spaceId: string,
    ownerSub: string,
    pluginId: string,
    e: ConnectorEntry,
    dir: string,
    now: string,
  ): Promise<string> {
    const fileId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const metadata: Record<string, unknown> = { path: dir };
    if (e.createdAt) metadata.createdAt = e.createdAt; // the backend's true creation time
    await this.db.batch([
      {
        sql: `INSERT INTO files (id, tenant_id, owner_id, name, current_version_id, metadata, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [fileId, spaceId, ownerSub, e.name, versionId, JSON.stringify(metadata), e.createdAt ?? now, e.modifiedAt ?? now],
      },
      {
        sql: `INSERT INTO file_versions (id, file_id, source, connector_id, external_key, etag, mime, size, extract_state, created_at, created_by)
              VALUES (?, ?, 'external', ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [versionId, fileId, pluginId, e.path, e.etag ?? null, e.contentType ?? null, e.size ?? 0, this.externalExtractState(e), now, ownerSub],
      },
      {
        sql: `INSERT OR IGNORE INTO relation_tuples (object_type, object_id, relation, subject_type, subject_id, subject_relation)
              VALUES ('file', ?, 'owner', 'user', ?, '')`,
        params: [fileId, ownerSub],
      },
      {
        sql: `INSERT OR IGNORE INTO relation_tuples (object_type, object_id, relation, subject_type, subject_id, subject_relation)
              VALUES ('file', ?, 'space', 'space', ?, '')`,
        params: [fileId, spaceId],
      },
    ]);
    await this.reindex(fileId); // findable by name immediately; body follows from the extract queue
    return fileId;
  }

  /** A changed external file: refresh the version, drop the stale cached text, and
   *  re-enqueue extraction, then reindex (title-only until the queue re-extracts). */
  private async updateExternalVersion(fileId: string, versionId: string, e: ConnectorEntry, now: string): Promise<void> {
    await this.db.run(
      "UPDATE file_versions SET etag = ?, size = ?, mime = ?, extract_state = ?, extract_attempts = 0, content_ref = NULL WHERE id = ?",
      [e.etag ?? null, e.size ?? 0, e.contentType ?? null, this.externalExtractState(e), versionId],
    );
    await this.db.run("UPDATE files SET updated_at = ? WHERE id = ?", [e.modifiedAt ?? now, fileId]);
    await this.reindex(fileId);
  }

  /** A renamed external file: move name + external_key in place (id kept), reindex.
   *  Content is unchanged (matched by etag), so extraction is NOT re-queued. */
  private async renameExternalFile(fileId: string, versionId: string, e: ConnectorEntry, now: string): Promise<void> {
    await this.db.run("UPDATE files SET name = ?, updated_at = ? WHERE id = ?", [e.name, e.modifiedAt ?? now, fileId]);
    await this.db.run("UPDATE file_versions SET external_key = ? WHERE id = ?", [e.path, versionId]);
    await this.reindex(fileId);
  }

  /** Tombstone files + folder rows under any direct subfolder of `dir` that the
   *  connector no longer lists. Returns the ids of the files tombstoned (for the
   *  reconcile's bulk sequence bump). */
  private async pruneGoneSubfolders(spaceId: string, dir: string, presentNames: Set<string>, now: string): Promise<string[]> {
    const filePaths = await this.db.all<{ p: string | null }>(
      "SELECT DISTINCT json_extract(metadata, '$.path') AS p FROM files WHERE tenant_id = ? AND deleted_at IS NULL",
      [spaceId],
    );
    const folderPaths = await this.db.all<{ path: string }>("SELECT path FROM folders WHERE space_id = ?", [spaceId]);
    const knownSubs = subfolders(dir, [...filePaths.map((r) => r.p ?? ""), ...folderPaths.map((r) => r.path)]);
    const removed: string[] = [];
    for (const name of knownSubs) {
      if (presentNames.has(name)) continue;
      const sub = dir ? `${dir}/${name}` : name;
      const under = `${sub}/%`;
      const rows = await this.db.all<{ id: string }>(
        `SELECT id FROM files WHERE tenant_id = ? AND deleted_at IS NULL
           AND (json_extract(metadata, '$.path') = ? OR json_extract(metadata, '$.path') LIKE ?)`,
        [spaceId, sub, under],
      );
      for (const r of rows) {
        await this.db.run("UPDATE files SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, r.id]);
        await this.deindex(r.id);
        removed.push(r.id);
      }
      await this.db.run("DELETE FROM folders WHERE space_id = ? AND (path = ? OR path LIKE ?)", [spaceId, sub, under]);
    }
    return removed;
  }

  /**
   * Drain a slice of the external-extract queue. For each `extract_state='pending'`
   * external file: read its bytes through the connector (the injected `readExternal`),
   * extract text, cache it in R2 (`content_ref`), and reindex with the body — so its
   * *content*, not just its name, is searchable and reachable by MCP. The state column
   * is the queue, so this is safe to call opportunistically (lazy-on-view) and from the
   * scheduled sweep. Best-effort per item: a failure flips it to 'error' (+attempt) for
   * a later retry, never aborts the batch. No-op without an index + a readExternal.
   */
  async drainExternalExtractQueue(limit = 20): Promise<{ extracted: number; failed: number }> {
    if (!this.opts.index || !this.opts.readExternal) return { extracted: 0, failed: 0 };
    const pending = await this.db.all<{ vid: string; file_id: string }>(
      `SELECT v.id AS vid, v.file_id FROM file_versions v JOIN files f ON f.id = v.file_id
        WHERE v.source = 'external' AND v.extract_state = 'pending' AND f.deleted_at IS NULL
        ORDER BY v.created_at LIMIT ?`,
      [limit],
    );
    let extracted = 0;
    let failed = 0;
    for (const row of pending) {
      try {
        const file = await this.loadFile(row.file_id);
        const version = file?.currentVersionId ? await this.loadVersion(file.currentVersionId) : null;
        // Skip if it moved on under us (current version changed / file trashed).
        if (!file || !version || version.id !== row.vid || version.source !== "external") {
          await this.db.run("UPDATE file_versions SET extract_state = 'skip' WHERE id = ? AND extract_state = 'pending'", [row.vid]);
          continue;
        }
        const text = await this.extractExternalText(file, version);
        let contentRef: string | null = null;
        if (text) {
          contentRef = `extract/${file.id}.txt`;
          await this.store.put(contentRef, new TextEncoder().encode(text));
        }
        // Only land if still 'pending' — a concurrent change may have re-queued it.
        await this.db.run(
          "UPDATE file_versions SET extract_state = 'done', content_ref = ? WHERE id = ? AND extract_state = 'pending'",
          [contentRef, row.vid],
        );
        await this.indexFileDoc(file, text ?? undefined);
        extracted++;
      } catch (err) {
        await this.db.run(
          "UPDATE file_versions SET extract_state = 'error', extract_attempts = extract_attempts + 1 WHERE id = ?",
          [row.vid],
        );
        failed++;
        console.warn(`[extract] external ${row.file_id} failed: ${(err as Error).message}`);
      }
    }
    return { extracted, failed };
  }

  /** Read + extract an external file's text through the connector (capped). Null when
   *  it isn't extractable or holds no usable text. */
  private async extractExternalText(file: FileRecord, version: FileVersion): Promise<string | null> {
    const readExternal = this.opts.readExternal;
    if (!readExternal) return null;
    if (isTextLike(file.name, version.mime)) {
      const stream = await readExternal(version, file);
      return stream ? readCappedText(stream, INDEX_MAX_TEXT_BYTES) : null;
    }
    const extractor = this.opts.textExtractor;
    if (extractor?.supports(file.name, version.mime)) {
      const stream = await readExternal(version, file);
      return stream ? (await extractor.extract(stream, file.name, version.mime)) ?? null : null;
    }
    return null;
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
