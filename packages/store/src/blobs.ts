import { sha256hex } from "./hash";
import type { BlobRepo, BlobStore } from "./blob-store";

/**
 * Content-addressed dedup + reference counting — the heart of the store, kept
 * free of SQL and HTTP so it can be unit-tested against in-memory fakes.
 *
 * Invariant: a blob's `ref_count` equals the number of file versions pointing
 * at it. Exactly one ref is added per stored-or-reused blob (by `prepareBlob`
 * on a hit, or `commitUpload` on a miss); each version delete releases one. The
 * bytes are deleted only when the count reaches 0.
 */

export class BlobHashMismatchError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`blob hash mismatch: expected ${expected}, got ${actual}`);
    this.name = "BlobHashMismatchError";
  }
}

/** Storage/dedup key. Tenant-namespaced by default so dedup never crosses tenants. */
export function blobKey(tenantId: string, hash: string, globalDedup = false): string {
  return globalDedup ? hash : `${tenantId}/${hash}`;
}

export interface PrepareResult {
  /** True when the bytes are already stored — no upload needed. */
  exists: boolean;
  refCount?: number;
}

/**
 * Dedup check for an upload. On a hit, reserves a reference (the caller will
 * create a version that points at it) and reports `exists: true`. On a miss,
 * the caller must upload the bytes and call {@link commitUpload}.
 */
export async function prepareBlob(repo: BlobRepo, key: string): Promise<PrepareResult> {
  const existing = await repo.find(key);
  if (!existing) return { exists: false };
  const refCount = await repo.increment(key);
  return { exists: true, refCount: refCount ?? existing.refCount + 1 };
}

/**
 * Store freshly-uploaded bytes after verifying they hash to the claimed value.
 * Never trusts the client's hash as the key without this server-side check.
 */
export async function commitUpload(
  repo: BlobRepo,
  store: BlobStore,
  args: { key: string; expectedHash: string; bytes: Uint8Array; now?: string },
): Promise<{ hash: string; size: number; refCount: number }> {
  const actual = await sha256hex(args.bytes);
  if (actual !== args.expectedHash) throw new BlobHashMismatchError(args.expectedHash, actual);
  await store.put(args.key, args.bytes);
  const refCount = await repo.insertOrIncrement(args.key, args.bytes.byteLength, args.now ?? new Date().toISOString());
  return { hash: actual, size: args.bytes.byteLength, refCount };
}

/**
 * Release one reference (a version or file was deleted). Deletes the bytes and
 * the blob row only when the count hits 0. Never deletes a blob directly.
 */
export async function releaseBlob(
  repo: BlobRepo,
  store: BlobStore,
  key: string,
): Promise<{ refCount: number; deleted: boolean }> {
  const count = await repo.decrement(key);
  if (count == null) return { refCount: 0, deleted: false };
  if (count <= 0) {
    await store.delete(key);
    await repo.delete(key);
    return { refCount: 0, deleted: true };
  }
  return { refCount: count, deleted: false };
}

/** Sweep any blobs left at ref_count ≤ 0 (defensive GC). Returns the keys removed. */
export async function collectGarbage(repo: BlobRepo, store: BlobStore, limit = 100): Promise<string[]> {
  const keys = await repo.zeroRefKeys(limit);
  for (const key of keys) {
    await store.delete(key);
    await repo.delete(key);
  }
  return keys;
}
