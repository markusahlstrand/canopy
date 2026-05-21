import type { Page, StorageConnector, StorageEntry } from "@canopy/core";

/**
 * Minimal structural type for an R2 bucket binding — just the methods this
 * connector uses. A real Cloudflare `R2Bucket` satisfies it, so we avoid a
 * dependency on @cloudflare/workers-types here.
 */
export interface R2BucketLike {
  list(opts?: { prefix?: string; delimiter?: string; limit?: number; cursor?: string }): Promise<{
    objects: { key: string; size: number; etag: string; uploaded: Date }[];
    delimitedPrefixes: string[];
    truncated: boolean;
    cursor?: string;
  }>;
  head(key: string): Promise<{ size: number; etag: string; uploaded: Date } | null>;
  get(key: string): Promise<{ body: ReadableStream<Uint8Array> } | null>;
  put(key: string, value: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer | string): Promise<unknown>;
  delete(key: string): Promise<void>;
}

/** "" → "", "a" → "a/", "a/b" → "a/b/" — the listing prefix for a folder. */
function asPrefix(path: string): string {
  const clean = path.replace(/^\/+|\/+$/g, "");
  return clean ? `${clean}/` : "";
}

function basename(key: string): string {
  return key.replace(/\/+$/, "").split("/").pop() ?? "";
}

/**
 * Storage connector over a Cloudflare R2 bucket. R2 is a flat key space;
 * folders are emulated with key prefixes + the "/" delimiter.
 */
export function createR2Connector(id: string, bucket: R2BucketLike): StorageConnector {
  return {
    id,

    async list(path): Promise<Page<StorageEntry>> {
      const prefix = asPrefix(path);
      const res = await bucket.list({ prefix, delimiter: "/" });
      const items: StorageEntry[] = [];
      for (const p of res.delimitedPrefixes) {
        items.push({ path: p.replace(/\/+$/, ""), name: basename(p), kind: "folder" });
      }
      for (const obj of res.objects) {
        const name = obj.key.slice(prefix.length);
        if (!name || name.endsWith("/")) continue; // skip the prefix placeholder itself
        items.push({
          path: obj.key,
          name,
          kind: "file",
          size: obj.size,
          modifiedAt: obj.uploaded.toISOString(),
          etag: obj.etag,
        });
      }
      items.sort((a, b) => (a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : a.name.localeCompare(b.name)));
      return { items, cursor: res.truncated ? res.cursor : undefined };
    },

    async stat(path): Promise<StorageEntry | null> {
      const key = path.replace(/^\/+|\/+$/g, "");
      const head = await bucket.head(key);
      if (head) {
        return { path: key, name: basename(key), kind: "file", size: head.size, modifiedAt: head.uploaded.toISOString(), etag: head.etag };
      }
      const res = await bucket.list({ prefix: `${key}/`, limit: 1 });
      if (res.objects.length || res.delimitedPrefixes.length) {
        return { path: key, name: basename(key), kind: "folder" };
      }
      return null;
    },

    async read(path): Promise<ReadableStream<Uint8Array>> {
      const obj = await bucket.get(path.replace(/^\/+/, ""));
      if (!obj) throw new Error(`not found: ${path}`);
      return obj.body;
    },

    async write(path, body): Promise<StorageEntry> {
      const key = path.replace(/^\/+/, "");
      await bucket.put(key, body);
      const head = await bucket.head(key);
      return {
        path: key,
        name: basename(key),
        kind: "file",
        size: head?.size,
        modifiedAt: head?.uploaded.toISOString(),
      };
    },

    async remove(path): Promise<void> {
      await bucket.delete(path.replace(/^\/+/, ""));
    },
  };
}
