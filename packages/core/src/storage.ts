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
  /** Optional: presigned URL for direct client transfer. */
  signedUrl?(path: string, op: "get" | "put", expiresInSeconds?: number): Promise<string>;
  /**
   * Optional change feed used to keep the index in sync. Connectors that can't
   * emit changes (e.g. plain R2) omit this; the host falls back to crawl +
   * lazy reconcile on read.
   */
  changes?(cursor?: string): AsyncIterable<ChangeEvent>;
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
  type: "string" | "secret" | "url" | "boolean";
  required?: boolean;
}
