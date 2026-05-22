import { describe, expect, it } from "vitest";
import type { BlobRepo, BlobStore } from "./blob-store";
import type { BlobRecord } from "./types";
import { BlobHashMismatchError, blobKey, collectGarbage, commitUpload, prepareBlob, releaseBlob } from "./blobs";
import { sha256hex } from "./hash";

// ── in-memory fakes — let the dedup/refcount logic be tested in isolation ──────

function memRepo() {
  const map = new Map<string, BlobRecord>();
  const repo: BlobRepo = {
    async find(key) {
      return map.get(key) ?? null;
    },
    async insertOrIncrement(key, size, now) {
      const e = map.get(key);
      if (e) {
        e.refCount += 1;
        return e.refCount;
      }
      map.set(key, { key, size, refCount: 1, createdAt: now });
      return 1;
    },
    async increment(key) {
      const e = map.get(key);
      if (!e) return null;
      e.refCount += 1;
      return e.refCount;
    },
    async decrement(key) {
      const e = map.get(key);
      if (!e) return null;
      e.refCount -= 1;
      return e.refCount;
    },
    async delete(key) {
      map.delete(key);
    },
    async zeroRefKeys(limit = 100) {
      return [...map.values()].filter((b) => b.refCount <= 0).slice(0, limit).map((b) => b.key);
    },
  };
  return { repo, map };
}

function memStore() {
  const map = new Map<string, Uint8Array>();
  const store: BlobStore = {
    async has(key) {
      return map.has(key);
    },
    async put(key, bytes) {
      map.set(key, bytes);
    },
    async get(key) {
      const b = map.get(key);
      return b ? new Response(b as unknown as BodyInit).body : null;
    },
    async delete(key) {
      map.delete(key);
    },
  };
  return { store, map };
}

const bytesOf = (s: string) => new TextEncoder().encode(s);

describe("blobKey", () => {
  it("namespaces by tenant by default; bare hash only with global dedup", () => {
    expect(blobKey("alice", "abc")).toBe("alice/abc");
    expect(blobKey("alice", "abc", true)).toBe("abc");
  });
});

describe("dedup + refcount", () => {
  it("new hash creates a blob at ref_count 1 and stores the bytes", async () => {
    const { repo, map } = memRepo();
    const { store, map: blobs } = memStore();
    const bytes = bytesOf("hello");
    const hash = await sha256hex(bytes);
    const key = blobKey("t", hash);

    const pre = await prepareBlob(repo, key);
    expect(pre.exists).toBe(false);

    const res = await commitUpload(repo, store, { key, expectedHash: hash, bytes });
    expect(res.refCount).toBe(1);
    expect(map.get(key)?.refCount).toBe(1);
    expect(blobs.has(key)).toBe(true);
  });

  it("duplicate hash increments ref_count and does NOT store a second blob", async () => {
    const { repo, map } = memRepo();
    const { store, map: blobs } = memStore();
    const bytes = bytesOf("dup");
    const hash = await sha256hex(bytes);
    const key = blobKey("t", hash);

    await commitUpload(repo, store, { key, expectedHash: hash, bytes });
    const pre = await prepareBlob(repo, key); // second file references same content

    expect(pre.exists).toBe(true);
    expect(pre.refCount).toBe(2);
    expect(map.get(key)?.refCount).toBe(2);
    expect(blobs.size).toBe(1);
  });

  it("delete-to-zero removes the blob and its bytes", async () => {
    const { repo, map } = memRepo();
    const { store, map: blobs } = memStore();
    const bytes = bytesOf("gone");
    const hash = await sha256hex(bytes);
    const key = blobKey("t", hash);

    await commitUpload(repo, store, { key, expectedHash: hash, bytes });
    const res = await releaseBlob(repo, store, key);

    expect(res.deleted).toBe(true);
    expect(res.refCount).toBe(0);
    expect(map.has(key)).toBe(false);
    expect(blobs.has(key)).toBe(false);
  });

  it("delete-above-zero retains the blob", async () => {
    const { repo, map } = memRepo();
    const { store, map: blobs } = memStore();
    const bytes = bytesOf("keep");
    const hash = await sha256hex(bytes);
    const key = blobKey("t", hash);

    await commitUpload(repo, store, { key, expectedHash: hash, bytes });
    await prepareBlob(repo, key); // ref_count → 2
    const res = await releaseBlob(repo, store, key); // → 1

    expect(res.deleted).toBe(false);
    expect(res.refCount).toBe(1);
    expect(map.get(key)?.refCount).toBe(1);
    expect(blobs.has(key)).toBe(true);
  });

  it("rejects bytes whose hash doesn't match the claimed value and stores nothing", async () => {
    const { repo, map } = memRepo();
    const { store, map: blobs } = memStore();
    const key = blobKey("t", "0".repeat(64));

    await expect(
      commitUpload(repo, store, { key, expectedHash: "0".repeat(64), bytes: bytesOf("tampered") }),
    ).rejects.toBeInstanceOf(BlobHashMismatchError);

    expect(map.size).toBe(0);
    expect(blobs.size).toBe(0);
  });

  it("releasing a missing blob is a no-op", async () => {
    const { repo } = memRepo();
    const { store } = memStore();
    const res = await releaseBlob(repo, store, blobKey("t", "deadbeef"));
    expect(res).toEqual({ refCount: 0, deleted: false });
  });

  it("collectGarbage sweeps only ref_count ≤ 0 blobs", async () => {
    const { repo, map } = memRepo();
    const { store } = memStore();
    const a = bytesOf("a");
    const b = bytesOf("b");
    const ka = blobKey("t", await sha256hex(a));
    const kb = blobKey("t", await sha256hex(b));
    await commitUpload(repo, store, { key: ka, expectedHash: await sha256hex(a), bytes: a });
    await commitUpload(repo, store, { key: kb, expectedHash: await sha256hex(b), bytes: b });
    await repo.decrement(ka); // ka → 0, kb stays 1

    const swept = await collectGarbage(repo, store);
    expect(swept).toEqual([ka]);
    expect(map.has(ka)).toBe(false);
    expect(map.has(kb)).toBe(true);
  });
});
