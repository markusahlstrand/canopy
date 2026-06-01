/** Resource-level role. owner ⊃ editor ⊃ viewer. */
export type Role = "owner" | "editor" | "viewer";

/** Immutable bytes, content-addressed. One row per (tenant-namespaced) hash. */
export interface BlobRecord {
  /** Storage key = the dedup id: `${tenant}/${sha256}` (or bare sha256 if global dedup). */
  key: string;
  size: number;
  refCount: number;
  createdAt: string;
}

/** A file: a mutable record that points at its current version. "The file". */
export interface FileRecord {
  id: string;
  tenantId: string;
  ownerId: string;
  name: string;
  currentVersionId: string | null;
  /** Freeform JSON. `path` holds the virtual-folder location (e.g. "Documents/2026"). */
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** Where a version's bytes live. */
export type ContentSource = "blob" | "external";

/**
 * Binds a file to its content at a point in time. Either a content-addressed
 * `blob` Canopy owns, or an `external` pointer into a connected store the user
 * owns (indexed by key + etag, not refcounted).
 */
export interface FileVersion {
  id: string;
  fileId: string;
  source: ContentSource;
  /** Blob storage key (tenant-namespaced hash). Present iff source === "blob". */
  blobKey: string | null;
  /** Connection id + object key + etag. Present iff source === "external". */
  connectorId: string | null;
  externalKey: string | null;
  etag: string | null;
  mime: string | null;
  size: number;
  createdAt: string;
  createdBy: string;
  /** Pinned: retention/pruning never removes a kept version (#11). */
  keep: boolean;
}

/** A connected backend (filesystem / S3 / R2) whose objects are indexed into the file table. */
export interface Connection {
  id: string;
  tenantId: string;
  ownerId: string;
  type: string;
  name: string;
  config: Record<string, unknown>;
  createdAt: string;
}

/** A drive: one personal space per user, plus shared "group" spaces (e.g. a family). */
export interface Space {
  id: string;
  name: string;
  kind: "personal" | "group";
  createdBy: string;
  createdAt: string;
  /** Optional sidebar icon name (defaults to the people icon when null). */
  icon: string | null;
  /** Optional accent color — an HSL triplet like "145 33% 36%". */
  color: string | null;
}

/** Directory entry, upserted on login so files can be shared by email. */
export interface User {
  sub: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  updatedAt: string;
}

export type IndexStatus = "queued" | "running" | "done" | "error";

/** One crawl of a connection. Resumable via `cursor`. */
export interface IndexRun {
  id: string;
  connectionId: string;
  status: IndexStatus;
  cursor: string | null;
  filesSeen: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface Permission {
  fileId: string;
  principal: string;
  role: Role;
}

/** A file record joined with its current version — what the API returns. */
export interface FileWithVersion extends FileRecord {
  version: FileVersion | null;
}

/** A comment on a file's discussion thread. Soft-deleted; `deletedAt` hides it. */
export interface FileComment {
  id: string;
  fileId: string;
  authorId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
