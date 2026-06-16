import "@typespec/http";

using TypeSpec.Http;

namespace Canopy;

/** Resource-level role. owner ⊃ editor ⊃ viewer. */
enum Role {
  owner,
  editor,
  viewer,
}

/**
 * A drive: one `personal` space per user, shared `group` spaces (e.g. a family),
 * and read-only `connected` spaces — a persisted index over a user's connected
 * backend (a Synology NAS, a GitHub repo).
 */
enum SpaceKind {
  personal,
  group,
  connected,
}

/** Where a version's bytes live: a blob Canopy owns, or a pointer into a connected store. */
enum ContentSource {
  blob,
  external,
}

/** A space as returned to the caller, including their role in it. */
model Space {
  @key id: string;
  name: string;
  kind: SpaceKind;
  /** The caller's role in this space. */
  role: Role;
  /** Show inline in "My Drive" (always true for the personal space). */
  mounted?: boolean;
  /** Read-only spaces (an indexed repo) refuse writes. */
  readonly?: boolean;
  /** Optional sidebar icon name. */
  icon?: string | null;
  /** Optional accent color — an HSL triplet like "145 33% 36%". */
  color?: string | null;
}

/** Fields accepted when creating a shared (group) space. */
model CreateSpace {
  name: string;
  icon?: string | null;
  color?: string | null;
}

/** Binds a file to its content at a point in time. */
model FileVersion {
  @key id: string;
  fileId: string;
  source: ContentSource;
  /** Connection id when `source` is `external`, else null. */
  connectorId?: string | null;
  mime?: string | null;
  size: int64;
  createdAt: utcDateTime;
  createdBy: string;
  /** Pinned: retention never prunes a kept version. */
  keep: boolean;
}

/** A file: a mutable record that points at its current version, joined with that version. */
model File {
  @key id: string;
  ownerId: string;
  name: string;
  currentVersionId?: string | null;
  /** Freeform JSON. `path` holds the virtual-folder location (e.g. "Documents/2026"). */
  metadata?: Record<unknown>;
  createdAt: utcDateTime;
  updatedAt: utcDateTime;
  /** Set when the file is in the trash. */
  deletedAt?: utcDateTime | null;
  /** The current version, joined in. */
  version?: FileVersion | null;
  /** Labels (emails / names) the file is shared with, beyond its owner. */
  sharedWith?: string[];
  ownerLabel?: string;
}

/** A folder entry within a space. */
model Folder {
  name: string;
  path: string;
}

/** One folder's listing within a space: the files and subfolders at `path`. */
model Listing {
  /** The folder path that was listed (root = ""). */
  path: string;
  files: File[];
  folders: Folder[];
  /** Present for connected spaces. */
  spaceName?: string;
}

/** Fields needed to create a file record once its blob has been uploaded. */
model CreateFile {
  name: string;
  /** SHA-256 of the uploaded bytes — ties the record to its prepared blob. */
  hash: string;
  mime?: string;
  /** Virtual-folder location within the space. */
  path?: string;
  metadata?: Record<unknown>;
}

/** Request to reserve an upload slot for content with the given hash. */
model PrepareUpload {
  /** SHA-256 of the bytes to upload. */
  hash: string;
  size?: int64;
}

/** Where (and whether) to upload. When `exists` is true the blob is already stored. */
model UploadTicket {
  /** True when the content-addressed blob already exists — skip the PUT. */
  exists: boolean;
  upload?: {
    method: "PUT";
    url: string;
  };
}

/** Result of streaming bytes to an upload ticket. */
model CommittedBlob {
  hash: string;
  size: int64;
}

/** One full-text search hit, scored and scoped to the caller's readable spaces. */
model SearchHit {
  @key id: string;
  spaceId: string;
  score: float64;
  title: string;
  snippet?: string;
  kind?: string;
  path?: string;
  modifiedAt?: utcDateTime;
}

/** A page of search hits. */
model SearchResults {
  items: SearchHit[];
  /** Present when more results are available. */
  cursor?: string;
}

/** Lightweight per-space stats for the dashboard. */
model Overview {
  files: int64;
  bytes: int64;
}

@error
model Error {
  /** HTTP-aligned error code. */
  code: int32;
  message: string;
}
