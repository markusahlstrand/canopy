export type EntryKind = "file" | "folder";

export interface StorageEntry {
  /** POSIX-style path within the connector, e.g. "photos/2026/img.heic". */
  path: string;
  name: string;
  kind: EntryKind;
  /** Bytes. Files only. */
  size?: number;
  /** ISO 8601. */
  modifiedAt?: string;
  /** ISO 8601 — the backend's own creation time, when it exposes one. */
  createdAt?: string;
  etag?: string;
  contentType?: string;
}

export interface ListOptions {
  cursor?: string;
  limit?: number;
}

export interface Page<T> {
  items: T[];
  /** Present when more results are available. */
  cursor?: string;
}

export type ChangeType = "created" | "updated" | "deleted";

export interface ChangeEvent {
  type: ChangeType;
  path: string;
  entry?: StorageEntry;
}

/** One ref in a connector that has a branch concept (e.g. a GitHub repo). */
export interface BranchInfo {
  name: string;
  /** The repo's default branch (HEAD) — never deletable. */
  isDefault: boolean;
  /** The branch the connector is currently rooted at. */
  current: boolean;
  /** Branch protection is on (a guard for the delete affordance). */
  protected?: boolean;
  /** Tip commit SHA, when the backend reports it. */
  commitSha?: string;
}

/**
 * Optional branch management for connectors backed by a versioned source (today:
 * GitHub). The connector is rooted at one branch — `list()` reports the rest so the
 * UI can switch (a switch is a config change the host persists, then re-indexes),
 * create, or delete. Create/delete are real writes against the backend and need a
 * token with write access; their errors bubble up verbatim. Connectors without a
 * branch concept (a NAS, R2) omit this and the UI shows no picker.
 */
export interface BranchOps {
  list(): Promise<BranchInfo[]>;
  create(name: string, from?: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/**
 * A storage backend. Trusted, typed I/O — NOT dynamic plugin code.
 * The bucket is the source of truth; the SQL index is a cache built from this.
 */
export interface StorageConnector {
  /** Connector instance id (a configured connection, e.g. "r2-family"). */
  readonly id: string;
  list(path: string, opts?: ListOptions): Promise<Page<StorageEntry>>;
  stat(path: string): Promise<StorageEntry | null>;
  read(path: string): Promise<ReadableStream<Uint8Array>>;
  write(path: string, body: ReadableStream<Uint8Array> | Uint8Array): Promise<StorageEntry>;
  remove(path: string): Promise<void>;
  /**
   * Optional: create an (empty) folder. Connectors with a real directory concept
   * (a NAS, a filesystem) implement it; flat key stores (R2) omit it — folders
   * there exist only implicitly as key prefixes.
   */
  mkdir?(path: string): Promise<void>;
  /** Optional: presigned URL for direct client transfer. */
  signedUrl?(path: string, op: "get" | "put", expiresInSeconds?: number): Promise<string>;
  /**
   * Optional change feed used to keep the index in sync. Connectors that can't
   * emit changes (e.g. plain R2) omit this; the host falls back to crawl +
   * lazy reconcile on read.
   */
  changes?(cursor?: string): AsyncIterable<ChangeEvent>;
  /** The branch this connector is rooted at, when it has a branch concept. */
  readonly branch?: string;
  /** Optional branch management (list / create / delete). See {@link BranchOps}. */
  branches?: BranchOps;
}

/** A storage connector packaged as a plugin: a factory plus its config contract. */
export interface StorageConnectorPlugin {
  /** Connector type, e.g. "local" | "s3" | "r2". */
  readonly type: string;
  readonly label: string;
  /** JSON-schema-ish description of the config this connector needs. */
  readonly configFields: ConnectorConfigField[];
  create(id: string, config: Record<string, unknown>): StorageConnector;
}

export interface ConnectorConfigField {
  key: string;
  label: string;
  type: "string" | "secret" | "url" | "boolean" | "select";
  required?: boolean;
  /**
   * Choices for a `"select"` field. Either provided statically, or left empty and
   * filled by the host when serving the schema (see `optionsFrom`).
   */
  options?: { value: string; label: string }[];
  /**
   * Ask the host to populate `options` from a named, dynamic source when it serves
   * the settings schema. `"ai-models"` = the models the AI gateway currently exposes.
   */
  optionsFrom?: "ai-models";
  /**
   * Show this field only when another field (typically a `"select"` like a
   * connection "mode") currently holds one of these values — so a multi-mode
   * connector reveals just the relevant inputs. Fields without `showWhen` always
   * show. The settings UI also clears a hidden non-secret field on save, so
   * switching modes doesn't leave a stale value behind.
   */
  showWhen?: { field: string; in: string[] };
}
