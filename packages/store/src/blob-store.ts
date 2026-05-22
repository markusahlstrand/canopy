import type { BlobRecord } from "./types";

/**
 * Content-addressed byte store. Keyed by the blob's storage key
 * (`${tenant}/${sha256}`), so identical content is stored exactly once.
 */
export interface BlobStore {
  has(key: string): Promise<boolean>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;
  delete(key: string): Promise<void>;
}

/**
 * Persistence for blob rows + their reference counts. Split out from the dedup
 * algorithm so the algorithm can be unit-tested against an in-memory fake.
 * Each mutation is atomic.
 */
export interface BlobRepo {
  find(key: string): Promise<BlobRecord | null>;
  /** Insert at ref_count=1, or increment if it already exists. Returns the resulting count. */
  insertOrIncrement(key: string, size: number, now: string): Promise<number>;
  /** ++ref_count; returns the new count, or null if the row is missing. */
  increment(key: string): Promise<number | null>;
  /** --ref_count; returns the new count, or null if the row is missing. */
  decrement(key: string): Promise<number | null>;
  delete(key: string): Promise<void>;
  /** Keys whose ref_count has reached 0 — candidates for GC. */
  zeroRefKeys(limit?: number): Promise<string[]>;
}
