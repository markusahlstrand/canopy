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
import { applyDelta, type MirrorChange, type MirrorFile, type MirrorScopeEntry, type MirrorStore } from "@canopy/mirror";
import type { FileItem } from "@/lib/mock-data";

export interface CachedContent {
  bytes: ArrayBuffer;
  mime: string;
  name: string;
  size: number;
  at: number;
  /** The content's ETag when fetched, for stale-while-revalidate (If-None-Match → 304).
   *  Absent on older rows — the next revalidation fetches fresh and records it. */
  etag?: string;
  /** The UI space token this file belongs to ("" = personal drive,
   *  "connector:<plugin>" = a connected space, else a group-space id). Drives the
   *  per-space cache budget. Older rows may lack it — treated as "" (personal). */
  spaceId?: string;
  /** Explicitly kept available offline (the file or its folder is "pinned"). Pinned
   *  bytes are guaranteed: fetched proactively, exempt from the per-space budget, and
   *  never LRU-evicted — distinct from opportunistic, evictable opened-file bytes. */
  pinned?: boolean;
}

/**
 * The local, per-device "available offline" pin set — the files and folders the user
 * asked to keep on THIS device, independent of star (a synced bookmark) and of the
 * per-space cache budget (an opportunistic LRU cap). Folder pins are recursive: every
 * file at or below the path is kept. Stored under `meta`/"pins"; kept in sync with the
 * content store's `pinned` flags by `reconcilePins` (see lib/api.ts).
 */
export interface Pins {
  /** Explicitly pinned file ids. */
  files: string[];
  /** Pinned folders, by UI space token + virtual path ("" = the whole space). */
  folders: { space: string; path: string }[];
}

const EMPTY_PINS: Pins = { files: [], folders: [] };

/** The caller's current ACL scope, as returned by the delta endpoint. */
export type MirrorScope = MirrorScopeEntry[];

interface CanopyDB extends DBSchema {
  listings: { key: string; value: { items: FileItem[]; at: number } };
  content: { key: string; value: CachedContent };
  meta: { key: string; value: unknown };
  // The synced metadata mirror: one row per file, keyed by id, indexed by space so
  // a folder view loads a whole space and derives it in JS (see @canopy/mirror).
  files: { key: string; value: MirrorFile; indexes: { "by-space": string } };
  // Sync state: the per-space cursor map under "cursors", the scope under "spaces".
  sync: { key: string; value: unknown };
}

const DB_NAME = "canopy-offline";
const DB_VERSION = 2;

/** How many recently-opened files to remember (drives offline content warming). */
const MAX_RECENT = 30;

/** Sentinel cache limit meaning "no size cap" (bounded only by the browser quota). */
export const CACHE_UNLIMITED = -1;
/** Per-space content budget used when a space has no explicit setting (1 GB). */
export const DEFAULT_CACHE_LIMIT = 1_000_000_000;

/** Friendly cache-size presets shown in a space's offline settings. Bytes (base-1000,
 *  matching the human-readable usage readout), where 0 = don't cache and
 *  {@link CACHE_UNLIMITED} = no cap. */
export const CACHE_PRESETS: readonly { label: string; bytes: number }[] = [
  { label: "Off", bytes: 0 },
  { label: "250 MB", bytes: 250_000_000 },
  { label: "1 GB", bytes: 1_000_000_000 },
  { label: "5 GB", bytes: 5_000_000_000 },
  { label: "Unlimited", bytes: CACHE_UNLIMITED },
];

let dbPromise: Promise<IDBPDatabase<CanopyDB>> | null = null;

function db(): Promise<IDBPDatabase<CanopyDB>> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("no indexedDB"));
  dbPromise ??= openDB<CanopyDB>(DB_NAME, DB_VERSION, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        d.createObjectStore("listings");
        d.createObjectStore("content");
        d.createObjectStore("meta");
      }
      if (oldVersion < 2) {
        const files = d.createObjectStore("files", { keyPath: "id" });
        files.createIndex("by-space", "spaceId");
        d.createObjectStore("sync");
      }
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

export async function cacheContent(url: string, c: CachedContent): Promise<void> {
  const space = c.spaceId ?? "";
  const limit = await readCacheLimit(space);
  // Pinned ("available offline") bytes are a guarantee, so they bypass the budget gates:
  // they're stored even when this space's opportunistic cache is Off or the file is larger
  // than the whole budget. The budget then governs only the *unpinned* (evictable) bytes.
  if (!c.pinned) {
    if (limit === 0) return; // caching disabled for this space
    if (limit !== CACHE_UNLIMITED && c.size > limit) return; // one file exceeds the whole budget
  }
  return safe(async () => {
    const d = await db();
    await d.put("content", c, url);
    if (limit !== CACHE_UNLIMITED) await enforceBudget(d, space, limit);
  }, undefined);
}

export function readContent(url: string): Promise<CachedContent | null> {
  return safe(async () => (await (await db()).get("content", url)) ?? null, null);
}

export function hasContent(url: string): Promise<boolean> {
  return safe(async () => (await (await db()).getKey("content", url)) != null, false);
}

/** Evict a space's oldest *unpinned* blobs until its evictable bytes fit within `limit`
 *  (getAll/getAllKeys share key order, so we can zip them). Pinned ("available offline")
 *  blobs are never counted or evicted — the budget caps only opportunistic content. */
async function enforceBudget(d: IDBPDatabase<CanopyDB>, space: string, limit: number): Promise<void> {
  const keys = await d.getAllKeys("content");
  const rows = await d.getAll("content");
  const mine = keys.map((k, i) => ({ k, c: rows[i] })).filter((x) => x.c && (x.c.spaceId ?? "") === space && !x.c.pinned);
  let total = mine.reduce((s, x) => s + (x.c!.size || 0), 0);
  if (total <= limit) return;
  mine.sort((a, b) => (a.c!.at || 0) - (b.c!.at || 0)); // oldest first
  const tx = d.transaction("content", "readwrite");
  const ops: Promise<unknown>[] = [];
  for (const x of mine) {
    if (total <= limit) break;
    ops.push(tx.store.delete(x.k));
    total -= x.c!.size || 0;
  }
  await Promise.all([...ops, tx.done]);
}

// ── per-space content budgets ─────────────────────────────────────────────────
// How many bytes of opened-file content we keep for each space, chosen by the user
// in a space's offline settings. A LOCAL, per-device preference — the cache lives in
// THIS browser — stored under `meta` and keyed by the UI space token. 0 = don't cache,
// CACHE_UNLIMITED = no cap; a space with no explicit setting falls back to
// DEFAULT_CACHE_LIMIT.

/** The per-space budget map (space token → bytes); absent spaces use the default. */
export function readCacheLimits(): Promise<Record<string, number>> {
  return safe(
    async () => ((await (await db()).get("meta", "cacheLimits")) as Record<string, number> | undefined) ?? {},
    {},
  );
}

/** This space's cache budget in bytes (or {@link CACHE_UNLIMITED}/0); the default when unset. */
export async function readCacheLimit(space: string | undefined): Promise<number> {
  const limits = await readCacheLimits();
  const key = space ?? "";
  return key in limits ? limits[key]! : DEFAULT_CACHE_LIMIT;
}

/** Set a space's cache budget, then bring its cached bytes within it — clearing the
 *  space when set to Off, or evicting the oldest down to a finite new limit. */
export async function setCacheLimit(space: string | undefined, bytes: number): Promise<void> {
  const key = space ?? "";
  await safe(async () => {
    const d = await db();
    const limits = ((await d.get("meta", "cacheLimits")) as Record<string, number> | undefined) ?? {};
    limits[key] = bytes;
    await d.put("meta", limits, "cacheLimits");
  }, undefined);
  if (bytes === 0) await clearSpaceContent(key);
  else if (bytes !== CACHE_UNLIMITED) await safe(async () => enforceBudget(await db(), key, bytes), undefined);
}

/** Total bytes of cached content for a space. */
export function cacheUsage(space: string | undefined): Promise<number> {
  const key = space ?? "";
  return safe(async () => {
    const rows = await (await db()).getAll("content");
    return rows.reduce((s, c) => s + ((c.spaceId ?? "") === key ? c.size || 0 : 0), 0);
  }, 0);
}

/** Drop a space's *opportunistic* cached blobs (on Off, or a manual "clear"). Pinned
 *  ("available offline") files are explicitly kept and survive — only un-pinning removes
 *  them — so the budget control governs only evictable, opened-file bytes. */
export async function clearSpaceContent(space: string | undefined): Promise<void> {
  const key = space ?? "";
  await safe(async () => {
    const d = await db();
    const keys = await d.getAllKeys("content");
    const rows = await d.getAll("content");
    const tx = d.transaction("content", "readwrite");
    const ops: Promise<unknown>[] = [];
    keys.forEach((k, i) => {
      if ((rows[i]?.spaceId ?? "") === key && !rows[i]?.pinned) ops.push(tx.store.delete(k));
    });
    await Promise.all([...ops, tx.done]);
  }, undefined);
}

// ── available-offline pins ────────────────────────────────────────────────────
// The per-device set of files/folders kept available offline (see {@link Pins}). This is
// just the *intent*; `reconcilePins` (lib/api.ts) turns it into downloaded, eviction-proof
// content by flipping the `pinned` flag on content rows. A LOCAL preference — the bytes
// live in THIS browser — so it's stored under `meta`, never synced to the server like star.

/** The current pin set (empty when nothing is pinned). */
export function readPins(): Promise<Pins> {
  return safe(async () => ((await (await db()).get("meta", "pins")) as Pins | undefined) ?? EMPTY_PINS, EMPTY_PINS);
}

function writePins(p: Pins): Promise<void> {
  return safe(async () => {
    await (await db()).put("meta", p, "pins");
  }, undefined);
}

/** Add/remove a single file's offline pin. */
export async function setFilePinned(id: string, on: boolean): Promise<void> {
  const p = await readPins();
  const files = on ? [...new Set([...p.files, id])] : p.files.filter((x) => x !== id);
  await writePins({ ...p, files });
}

/** Add/remove a folder's (recursive) offline pin, keyed by UI space token + path. */
export async function setFolderPinned(space: string | undefined, path: string, on: boolean): Promise<void> {
  const p = await readPins();
  const sp = space ?? "";
  const same = (f: { space: string; path: string }) => f.space === sp && f.path === path;
  const folders = on ? [...p.folders.filter((f) => !same(f)), { space: sp, path }] : p.folders.filter((f) => !same(f));
  await writePins({ ...p, folders });
}

/** Flip the `pinned` flag on an already-cached content row (no-op if it isn't cached).
 *  Clearing the flag makes the bytes evictable again, so re-enforce the space's budget. */
export async function markContentPinned(url: string, pinned: boolean): Promise<void> {
  await safe(async () => {
    const d = await db();
    const row = await d.get("content", url);
    if (!row || !!row.pinned === pinned) return;
    await d.put("content", { ...row, pinned }, url);
    if (!pinned) {
      const space = row.spaceId ?? "";
      const limit = await readCacheLimit(space);
      if (limit !== CACHE_UNLIMITED) await enforceBudget(d, space, limit);
    }
  }, undefined);
}

/** Clear the `pinned` flag on every content row whose url isn't in `keep` — i.e. release
 *  the bytes of files that are no longer pinned — then bring each touched space back within
 *  its budget. The companion to `reconcilePins`'s "protect what's still pinned" pass. */
export async function unpinContentExcept(keep: Set<string>): Promise<void> {
  await safe(async () => {
    const d = await db();
    const keys = await d.getAllKeys("content");
    const rows = await d.getAll("content");
    const touched = new Set<string>();
    const tx = d.transaction("content", "readwrite");
    const ops: Promise<unknown>[] = [];
    keys.forEach((k, i) => {
      const r = rows[i];
      if (r?.pinned && !keep.has(k as string)) {
        ops.push(tx.store.put({ ...r, pinned: false }, k));
        touched.add(r.spaceId ?? "");
      }
    });
    await Promise.all([...ops, tx.done]);
    for (const space of touched) {
      const limit = await readCacheLimit(space);
      if (limit !== CACHE_UNLIMITED) await enforceBudget(d, space, limit);
    }
  }, undefined);
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

// ── synced metadata mirror (IndexedDB adapter) ────────────────────────────────
// The browser's local replica of the file metadata the caller can see. Filled by a
// cursor-based delta (see lib/sync.ts) and read folder-by-folder via @canopy/mirror's
// `folderView`. Metadata only — bytes stay in the `content` store above.
//
// These functions are the IndexedDB implementation of @canopy/mirror's `MirrorStore`,
// exposed as `idbMirrorStore` below. `sync.ts` depends on that interface, not on `idb`,
// so an alternative engine (e.g. Drizzle + SQLite-WASM/OPFS) can be dropped in by
// implementing the same interface — no change to the sync layer or the app.

/** Every (live) mirror row for a space, for deriving one folder's view. */
function readMirrorSpace(spaceId: string): Promise<MirrorFile[]> {
  return safe(async () => (await (await db()).getAllFromIndex("files", "by-space", spaceId)) ?? [], []);
}

/** Apply a delta batch: upsert live rows, delete tombstoned ones. One transaction. */
function applyMirrorChanges(changes: MirrorChange[]): Promise<void> {
  if (changes.length === 0) return Promise.resolve();
  return safe(async () => {
    const d = await db();
    const tx = d.transaction("files", "readwrite");
    // Reuse the shared fold so client and server agree on what a delta means: we feed
    // each change through applyDelta against a tiny per-change map to normalize it.
    const ops: Promise<unknown>[] = [];
    for (const c of changes) {
      const folded = applyDelta(new Map(), [c]);
      if (folded.size === 0) ops.push(tx.store.delete(c.id));
      else for (const row of folded.values()) ops.push(tx.store.put(row));
    }
    await Promise.all([...ops, tx.done]);
  }, undefined);
}

/** Delete every mirror row for a space — on revoked access or a hard reset. */
function dropMirrorSpace(spaceId: string): Promise<void> {
  return safe(async () => {
    const d = await db();
    const keys = await d.getAllKeysFromIndex("files", "by-space", spaceId);
    if (!keys.length) return;
    const tx = d.transaction("files", "readwrite");
    await Promise.all([...keys.map((k) => tx.store.delete(k)), tx.done]);
  }, undefined);
}

/** The per-space high-water seq map the delta endpoint echoes back as `since`. */
function readCursors(): Promise<Record<string, number>> {
  return safe(async () => ((await (await db()).get("sync", "cursors")) as Record<string, number> | undefined) ?? {}, {});
}

function writeCursors(cursors: Record<string, number>): Promise<void> {
  return safe(async () => {
    await (await db()).put("sync", cursors, "cursors");
  }, undefined);
}

function readScope(): Promise<MirrorScope> {
  return safe(async () => ((await (await db()).get("sync", "spaces")) as MirrorScope | undefined) ?? [], []);
}

function writeScope(spaces: MirrorScope): Promise<void> {
  return safe(async () => {
    await (await db()).put("sync", spaces, "spaces");
  }, undefined);
}

/**
 * IndexedDB implementation of the mirror's storage contract. Swap this for another
 * `MirrorStore` (e.g. a Drizzle/SQLite-WASM adapter) without touching `sync.ts`.
 */
export const idbMirrorStore: MirrorStore = {
  readSpace: readMirrorSpace,
  applyChanges: applyMirrorChanges,
  dropSpace: dropMirrorSpace,
  readCursors,
  writeCursors,
  readScope,
  writeScope,
};
