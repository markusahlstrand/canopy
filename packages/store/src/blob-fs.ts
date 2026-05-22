import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BlobStore } from "./blob-store";

/**
 * Content-addressed {@link BlobStore} on the local filesystem, for the Node /
 * Docker target. Keys (`tenant/sha256`) map to files under `root`.
 */
export function createFsBlobStore(root: string): BlobStore {
  const pathFor = (key: string) => join(root, ...key.split("/"));
  return {
    async has(key) {
      try {
        await stat(pathFor(key));
        return true;
      } catch {
        return false;
      }
    },
    async put(key, bytes) {
      const file = pathFor(key);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bytes);
    },
    async get(key) {
      try {
        const bytes = await readFile(pathFor(key));
        // Wrap the buffer as a web ReadableStream so the API streams it like R2.
        return new Response(bytes as unknown as BodyInit).body;
      } catch {
        return null;
      }
    },
    async delete(key) {
      await rm(pathFor(key), { force: true });
    },
  };
}
