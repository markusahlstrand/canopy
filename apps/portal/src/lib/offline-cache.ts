/**
 * Offline cache (IndexedDB) for view-only browsing when the backend is
 * unreachable. Holds three things, all best-effort:
 *
 *   • listings — the file rows of folders/views we've fetched, keyed by
 *     space+path, so Starred/Recent and browsed folders still populate offline.
 *   • content  — the bytes of files we've opened (recent) or that are starred,
 *     so their viewers can render offline. Size-capped and LRU-evicted.
 *   • meta     — the last-known signed-in identity and the recent-file list.
 *
 * The cache is never load-bearing: every operation swallows IndexedDB errors and
 * falls back to a benign default, so a blocked/full/absent IndexedDB just means
 * "no offline copy", never a crash.
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { FileItem } from "@/lib/mock-data";

export interface CachedContent {
  bytes: ArrayBuffer;
  mime: string;
  name: string;
  size: number;
  at: number;
}

interface CanopyDB extends DBSchema {
  listings: { key: string; value: { items: FileItem[]; at: number } };
  content: { key: string; value: CachedContent };
  meta: { key: string; value: unknown };
}

const DB_NAME = "canopy-offline";
const DB_VERSION = 1;

/** Skip caching blobs larger than this — keeps the storage quota sane. */
export const MAX_CACHED_BYTES = 25 * 1024 * 1024;
/** Keep at most this many cached blobs; oldest are evicted first. */
const MAX_CONTENT_ENTRIES = 120;
/** How many recently-opened files to remember (drives offline content warming). */
const MAX_RECENT = 30;

let dbPromise: Promise<IDBPDatabase<CanopyDB>> | null = null;

function db(): Promise<IDBPDatabase<CanopyDB>> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("no indexedDB"));
  dbPromise ??= openDB<CanopyDB>(DB_NAME, DB_VERSION, {
    upgrade(d) {
      d.createObjectStore("listings");
      d.createObjectStore("content");
      d.createObjectStore("meta");
    },
  });
  return dbPromise;
}

/** Run an IndexedDB op, falling back to `fallback` on any failure. */
async function safe<T>(op: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await op();
  } catch {
    return fallback;
  }
}

// ── listings ──────────────────────────────────────────────────────────────────

/** Stable key for a folder/view: its space (or "") and virtual path. */
export function listingKey(space: string | undefined, path: string): string {
  return `${space ?? ""}\n${path}`;
}

export function cacheListing(key: string, items: FileItem[]): Promise<void> {
  return safe(async () => {
    await (await db()).put("listings", { items, at: Date.now() }, key);
  }, undefined);
}

export function readListing(key: string): Promise<FileItem[] | null> {
  return safe(async () => (await (await db()).get("listings", key))?.items ?? null, null);
}

// ── content blobs ───────────────────────────────────────────────────────────

export function cacheContent(url: string, c: CachedContent): Promise<void> {
  if (c.size > MAX_CACHED_BYTES) return Promise.resolve();
  return safe(async () => {
    const d = await db();
    await d.put("content", c, url);
    await evictContent(d);
  }, undefined);
}

export function readContent(url: string): Promise<CachedContent | null> {
  return safe(async () => (await (await db()).get("content", url)) ?? null, null);
}

export function hasContent(url: string): Promise<boolean> {
  return safe(async () => (await (await db()).getKey("content", url)) != null, false);
}

/** Evict oldest blobs once we're over the entry budget (getAll* share key order). */
async function evictContent(d: IDBPDatabase<CanopyDB>): Promise<void> {
  const keys = await d.getAllKeys("content");
  if (keys.length <= MAX_CONTENT_ENTRIES) return;
  const rows = await d.getAll("content");
  const oldestFirst = keys
    .map((k, i) => ({ k, at: rows[i]?.at ?? 0 }))
    .sort((a, b) => a.at - b.at)
    .slice(0, keys.length - MAX_CONTENT_ENTRIES);
  const tx = d.transaction("content", "readwrite");
  await Promise.all([...oldestFirst.map(({ k }) => tx.store.delete(k)), tx.done]);
}

// ── recent file ids ───────────────────────────────────────────────────────────

export function readRecent(): Promise<string[]> {
  return safe(async () => ((await (await db()).get("meta", "recent")) as string[] | undefined) ?? [], []);
}

export function rememberRecent(id: string): Promise<void> {
  return safe(async () => {
    const d = await db();
    const cur = ((await d.get("meta", "recent")) as string[] | undefined) ?? [];
    await d.put("meta", [id, ...cur.filter((x) => x !== id)].slice(0, MAX_RECENT), "recent");
  }, undefined);
}

// ── cached identity ─────────────────────────────────────────────────────────

export function cacheMe(me: unknown): Promise<void> {
  return safe(async () => {
    await (await db()).put("meta", me, "me");
  }, undefined);
}

export function readMe<T>(): Promise<T | null> {
  return safe(async () => ((await (await db()).get("meta", "me")) as T | undefined) ?? null, null);
}
