import type { Db } from "./db";
import type { BlobRepo, BlobStore } from "./blob-store";
import type { FileRecord, FileVersion, FileWithVersion, Role } from "./types";
import { blobKey, commitUpload, prepareBlob, releaseBlob, type PrepareResult } from "./blobs";

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

const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

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
  tenant_id: string;
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

export interface CreateFileInput {
  name: string;
  /** sha256 of the content; the blob must already be prepared/uploaded. */
  hash: string;
  mime?: string;
  /** Virtual folder, e.g. "Documents/2026". */
  path?: string;
  metadata?: Record<string, unknown>;
}

/**
 * File/version/permission operations over a {@link Db} + {@link BlobStore}.
 * Every method takes the acting tenant and principal and enforces resource
 * roles itself (reads need viewer, writes editor, deletes owner). With the
 * tenant-per-user model the tenant is the user's `sub`.
 */
export class FileService {
  constructor(
    private readonly db: Db,
    private readonly store: BlobStore,
    private readonly repo: BlobRepo,
    private readonly opts: { globalDedup?: boolean } = {},
  ) {}

  keyFor(tenantId: string, hash: string): string {
    return blobKey(tenantId, hash, this.opts.globalDedup);
  }

  // ── uploads ────────────────────────────────────────────────────────────────

  /** Dedup check. `exists` → skip upload; otherwise PUT the bytes then create the file/version. */
  prepareUpload(tenantId: string, hash: string): Promise<PrepareResult> {
    return prepareBlob(this.repo, this.keyFor(tenantId, hash));
  }

  /** Verify + store uploaded bytes for a (previously-missed) blob. */
  commitUpload(tenantId: string, hash: string, bytes: Uint8Array) {
    return commitUpload(this.repo, this.store, { key: this.keyFor(tenantId, hash), expectedHash: hash, bytes });
  }

  // ── files ────────────────────────────────────────────────────────────────

  async createFile(tenantId: string, principal: string, input: CreateFileInput): Promise<FileWithVersion> {
    const key = this.keyFor(tenantId, input.hash);
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
        params: [fileId, tenantId, principal, input.name, versionId, JSON.stringify(metadata), now, now],
      },
      {
        sql: `INSERT INTO file_versions (id, file_id, source, blob_hash, mime, size, created_at, created_by)
              VALUES (?, ?, 'blob', ?, ?, ?, ?, ?)`,
        params: [versionId, fileId, key, input.mime ?? null, blob.size, now, principal],
      },
      {
        sql: `INSERT INTO file_permissions (file_id, principal, role) VALUES (?, ?, 'owner')`,
        params: [fileId, principal],
      },
    ]);

    return (await this.getFile(tenantId, principal, fileId))!;
  }

  /** File record + current version. Requires viewer+. */
  async getFile(tenantId: string, principal: string, id: string): Promise<FileWithVersion> {
    const file = await this.requireRole(tenantId, principal, id, "viewer");
    const version = file.currentVersionId ? await this.loadVersion(file.currentVersionId) : null;
    return { ...file, version };
  }

  /** The current version's blob key for streaming a managed download. Requires viewer+. */
  async getContentKey(tenantId: string, principal: string, id: string): Promise<{ key: string; version: FileVersion }> {
    const { version } = await this.getFile(tenantId, principal, id);
    if (!version) throw new NotFoundError("file has no content");
    if (version.source !== "blob" || !version.blobKey) throw new NotFoundError("not a managed blob");
    return { key: version.blobKey, version };
  }

  /** List a virtual folder: the files whose `metadata.path` equals `dir`, plus child folder names. */
  async list(tenantId: string, principal: string, dir = ""): Promise<{ path: string; files: FileWithVersion[]; folders: string[] }> {
    const path = normPath(dir);
    const rows = await this.db.all<FileRow & Partial<VersionRow> & { v_id: string | null; v_created_at: string | null }>(
      `SELECT f.*, v.id AS v_id, v.source, v.blob_hash, v.connector_id, v.external_key, v.etag,
              v.mime, v.size, v.created_by, v.created_at AS v_created_at
       FROM files f LEFT JOIN file_versions v ON v.id = f.current_version_id
       WHERE f.tenant_id = ? AND f.owner_id = ? AND f.deleted_at IS NULL
         AND json_extract(f.metadata, '$.path') = ?
       ORDER BY f.name`,
      [tenantId, principal, path],
    );
    const files: FileWithVersion[] = rows.map((r) => ({
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
    }));

    const pathRows = await this.db.all<{ p: string | null }>(
      `SELECT DISTINCT json_extract(metadata, '$.path') AS p
       FROM files WHERE tenant_id = ? AND owner_id = ? AND deleted_at IS NULL`,
      [tenantId, principal],
    );
    const folders = subfolders(path, pathRows.map((r) => r.p ?? ""));
    return { path, files, folders };
  }

  /** Merge into the metadata JSON. Does NOT create a new version. Requires editor+. */
  async patchMetadata(tenantId: string, principal: string, id: string, patch: Record<string, unknown>): Promise<FileWithVersion> {
    const file = await this.requireRole(tenantId, principal, id, "editor");
    const metadata = { ...file.metadata, ...patch };
    if ("path" in patch) metadata.path = normPath(String(patch.path ?? ""));
    const now = new Date().toISOString();
    await this.db.run("UPDATE files SET metadata = ?, updated_at = ? WHERE id = ?", [JSON.stringify(metadata), now, id]);
    return (await this.getFile(tenantId, principal, id))!;
  }

  /** Add a new version (new content) without touching metadata. Requires editor+. Dedup applies upstream. */
  async addVersion(tenantId: string, principal: string, id: string, input: { hash: string; mime?: string }): Promise<FileWithVersion> {
    await this.requireRole(tenantId, principal, id, "editor");
    const key = this.keyFor(tenantId, input.hash);
    const blob = await this.repo.find(key);
    if (!blob) throw new BlobMissingError();
    const now = new Date().toISOString();
    const versionId = crypto.randomUUID();
    await this.db.batch([
      {
        sql: `INSERT INTO file_versions (id, file_id, source, blob_hash, mime, size, created_at, created_by)
              VALUES (?, ?, 'blob', ?, ?, ?, ?, ?)`,
        params: [versionId, id, key, input.mime ?? null, blob.size, now, principal],
      },
      { sql: "UPDATE files SET current_version_id = ?, updated_at = ? WHERE id = ?", params: [versionId, now, id] },
    ]);
    return (await this.getFile(tenantId, principal, id))!;
  }

  /**
   * Soft-delete the file (record kept for audit) and release a blob reference
   * for each of its versions. The version rows are removed first so releasing a
   * blob to ref 0 doesn't violate the `file_versions → blobs` foreign key.
   * Requires owner.
   */
  async deleteFile(tenantId: string, principal: string, id: string): Promise<void> {
    await this.requireRole(tenantId, principal, id, "owner");
    const now = new Date().toISOString();
    const versions = await this.db.all<{ blob_hash: string }>("SELECT blob_hash FROM file_versions WHERE file_id = ?", [id]);
    await this.db.batch([
      { sql: "DELETE FROM file_versions WHERE file_id = ?", params: [id] },
      { sql: "UPDATE files SET deleted_at = ?, current_version_id = NULL WHERE id = ?", params: [now, id] },
    ]);
    for (const v of versions) await releaseBlob(this.repo, this.store, v.blob_hash);
  }

  // ── authorization ──────────────────────────────────────────────────────────

  async roleFor(file: FileRecord, principal: string): Promise<Role | null> {
    if (principal === file.ownerId) return "owner";
    const row = await this.db.first<{ role: Role }>(
      "SELECT role FROM file_permissions WHERE file_id = ? AND principal = ?",
      [file.id, principal],
    );
    return row?.role ?? null;
  }

  private async requireRole(tenantId: string, principal: string, id: string, needed: Role): Promise<FileRecord> {
    const file = await this.loadFile(tenantId, id);
    if (!file) throw new NotFoundError();
    const role = await this.roleFor(file, principal);
    if (!role || ROLE_RANK[role] < ROLE_RANK[needed]) throw new PermissionError();
    return file;
  }

  private async loadFile(tenantId: string, id: string): Promise<FileRecord | null> {
    const row = await this.db.first<FileRow>(
      "SELECT * FROM files WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL",
      [id, tenantId],
    );
    return row ? toFile(row) : null;
  }

  private async loadVersion(id: string): Promise<FileVersion | null> {
    const row = await this.db.first<VersionRow>("SELECT * FROM file_versions WHERE id = ?", [id]);
    return row ? toVersion(row) : null;
  }
}
