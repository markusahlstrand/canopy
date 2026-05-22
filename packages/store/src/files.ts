import type { Db } from "./db";
import type { BlobRepo, BlobStore } from "./blob-store";
import type { FileRecord, FileVersion, FileWithVersion, Role, Space } from "./types";
import { blobKey, commitUpload, prepareBlob, releaseBlob, type PrepareResult } from "./blobs";
import { ROLE_RANK, deleteTuple, fileGrants, fileRole, memberSpaceIds, spaceRole, writeTuple, type SubjectType, type Tuple } from "./authz";
import {
  addMember,
  createSpace as createGroupSpace,
  ensurePersonalSpace,
  listMembers,
  listSpacesForUser,
  removeMember,
  setMounted,
  type SpaceMember,
  type SpaceView,
} from "./spaces";
import { findUserByEmail } from "./users";

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
    private readonly opts: { globalDedup?: boolean } = {},
  ) {}

  keyFor(spaceId: string, hash: string): string {
    return blobKey(spaceId, hash, this.opts.globalDedup);
  }

  /** Ensure + return the caller's personal space id (the default drive). */
  personalSpace(userSub: string): Promise<string> {
    return ensurePersonalSpace(this.db, userSub);
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
   * Add a member by email. Requires owner on the space. The invitee must already
   * exist in the directory (have signed in once) — space membership is by `sub`,
   * not a pending email invite (per-file sharing supports email invites instead).
   */
  async addSpaceMember(caller: Caller, spaceId: string, email: string, role: Role): Promise<SpaceMember> {
    await this.requireSpace(caller.sub, spaceId, "owner");
    const user = await findUserByEmail(this.db, email);
    if (!user) throw new NotFoundError("no such user — they must sign in once before joining a space");
    await addMember(this.db, spaceId, user.sub, role);
    return { sub: user.sub, role, email: user.email, name: user.name };
  }

  async removeSpaceMember(caller: Caller, spaceId: string, sub: string): Promise<void> {
    await this.requireSpace(caller.sub, spaceId, "owner");
    await removeMember(this.db, spaceId, sub);
  }

  /** Resolve an email to a known user (for turning share-by-email into a user grant). */
  resolveEmail(email: string) {
    return findUserByEmail(this.db, email);
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

  /** The current version's blob key for streaming a managed download. Requires viewer+. */
  async getContentKey(caller: Caller, id: string): Promise<{ key: string; version: FileVersion }> {
    const { version } = await this.getFile(caller, id);
    if (!version) throw new NotFoundError("file has no content");
    if (version.source !== "blob" || !version.blobKey) throw new NotFoundError("not a managed blob");
    return { key: version.blobKey, version };
  }

  /** List a virtual folder within a space the caller can see. */
  async list(userSub: string, spaceId: string, dir = ""): Promise<{ path: string; files: FileWithVersion[]; folders: string[] }> {
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
    return { path, files: rows.map(joinedToFileWithVersion), folders: subfolders(path, pathRows.map((r) => r.p ?? "")) };
  }

  /** Files shared directly with the caller that live outside their own spaces. */
  async listSharedWithMe(userSub: string): Promise<FileWithVersion[]> {
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
    return rows.map(joinedToFileWithVersion);
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

  /** Add a new version (new content) without touching metadata. Requires editor+. */
  async addVersion(caller: Caller, id: string, input: { hash: string; mime?: string }): Promise<FileWithVersion> {
    const file = await this.requirePerm(caller, id, "editor");
    const key = this.keyFor(file.tenantId, input.hash); // blob lives in the file's space
    const blob = await this.repo.find(key);
    if (!blob) throw new BlobMissingError();
    const now = new Date().toISOString();
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

  /** Soft-delete the file (record kept), removing version rows then releasing each blob ref. Requires owner. */
  async deleteFile(caller: Caller, id: string): Promise<void> {
    await this.requirePerm(caller, id, "owner");
    const now = new Date().toISOString();
    const versions = await this.db.all<{ blob_hash: string | null }>(
      "SELECT blob_hash FROM file_versions WHERE file_id = ? AND blob_hash IS NOT NULL",
      [id],
    );
    await this.db.batch([
      { sql: "DELETE FROM file_versions WHERE file_id = ?", params: [id] },
      { sql: "UPDATE files SET deleted_at = ?, current_version_id = NULL WHERE id = ?", params: [now, id] },
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
      subjectId: grant.subjectId,
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
      subjectId: grant.subjectId,
      subjectRelation: grant.subjectType === "space" ? (grant.subjectRelation ?? "member") : "",
    });
  }

  /** All grants on a file (for a Share dialog). Requires viewer+. */
  async listGrants(caller: Caller, fileId: string): Promise<Tuple[]> {
    await this.requirePerm(caller, fileId, "viewer");
    return fileGrants(this.db, fileId);
  }

  // ── authorization ──────────────────────────────────────────────────────────

  private async requirePerm(caller: Caller, id: string, required: Role): Promise<FileRecord> {
    const file = await this.loadFile(id);
    if (!file) throw new NotFoundError();
    const role = await fileRole(this.db, id, caller.sub, caller.email ?? "");
    if (!role || ROLE_RANK[role] < ROLE_RANK[required]) throw new PermissionError();
    return file;
  }

  private async requireSpace(userSub: string, spaceId: string, required: Role): Promise<void> {
    const role = await spaceRole(this.db, spaceId, userSub);
    if (!role || ROLE_RANK[role] < ROLE_RANK[required]) throw new PermissionError();
  }

  private async loadFile(id: string): Promise<FileRecord | null> {
    const row = await this.db.first<FileRow>("SELECT * FROM files WHERE id = ? AND deleted_at IS NULL", [id]);
    return row ? toFile(row) : null;
  }

  private async loadVersion(id: string): Promise<FileVersion | null> {
    const row = await this.db.first<VersionRow>("SELECT * FROM file_versions WHERE id = ?", [id]);
    return row ? toVersion(row) : null;
  }
}
