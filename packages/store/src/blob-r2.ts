import type { BlobStore } from "./blob-store";

/** Minimal structural type for an R2 bucket binding (no @cloudflare/workers-types dep). */
export interface R2BucketLike {
  head(key: string): Promise<unknown | null>;
  get(key: string): Promise<{ body: ReadableStream<Uint8Array> } | null>;
  put(key: string, value: Uint8Array): Promise<unknown>;
  delete(key: string): Promise<void>;
}

/** Content-addressed {@link BlobStore} over a Cloudflare R2 bucket. The key is the blob's storage key. */
export function createR2BlobStore(bucket: R2BucketLike): BlobStore {
  return {
    async has(key) {
      return (await bucket.head(key)) != null;
    },
    async put(key, bytes) {
      await bucket.put(key, bytes);
    },
    async get(key) {
      const obj = await bucket.get(key);
      return obj?.body ?? null;
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}
