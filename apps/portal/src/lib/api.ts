import type { AiMessage, Page, PluginManifest, StorageEntry } from "@canopy/core";
// The plugin-settings contract lives in the SDK (it's a generic plugin concept);
// re-exported here so existing `@/lib/api` consumers keep importing it unchanged.
import type { PluginConfigField, PluginPlace, PluginSettings } from "@canopy/plugin-sdk";
export type { PluginConfigField, PluginPlace, PluginSettings };
import type { MirrorFile } from "@canopy/mirror";
import type { FileItem, FileKind, ProcessingEntry } from "@/lib/mock-data";
import { apiFetch, isBackendReachable } from "@/lib/connectivity";
import { MIRROR_ENABLED, mirrorFilesUnder, mirrorFolder } from "@/lib/sync";
import {
  cacheContent,
  cacheListing,
  cacheMe,
  hasContent,
  listingKey,
  markContentPinned,
  readContent,
  readListing,
  readMe,
  readPins,
  rememberRecent,
  setFilePinned,
  setFolderPinned,
  unpinContentExcept,
  type Pins,
} from "@/lib/offline-cache";

// Per-space offline cache controls — surfaced in a space's "Offline files" settings.
export {
  CACHE_PRESETS,
  CACHE_UNLIMITED,
  DEFAULT_CACHE_LIMIT,
  cacheUsage,
  clearSpaceContent,
  readCacheLimit,
  setCacheLimit,
} from "@/lib/offline-cache";

const EXT_KIND: Record<string, FileKind> = {
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  heic: "image",
  svg: "image",
  md: "note",
  txt: "note",
  doc: "doc",
  docx: "doc",
  pages: "doc",
  mp3: "audio",
  wav: "audio",
  flac: "audio",
  m4a: "audio",
  mp4: "video",
  mov: "video",
  mkv: "video",
};

function kindForName(name: string): FileKind {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_KIND[ext] ?? "doc";
}

export function humanSize(bytes?: number): string {
  if (bytes == null) return "—";
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1000;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
}

const join = (dir: string, name: string) => [dir, name].filter(Boolean).join("/");

/** SHA-256 of bytes as lowercase hex (browser Web Crypto). */
async function sha256hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  let hex = "";
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Turn a failed response into an Error carrying the *server's* reason. The API
 * answers errors as `{ error: "<message>" }` (see `handle()` in the API app), so
 * a connector failure — "QuickConnect … no candidate address responded", bad
 * DSM credentials, an edge proxy's non-JSON page — reaches the user instead of a
 * generic "<verb> failed: 400". Falls back to the status when there's no body.
 */
async function apiError(res: Response, fallback: string): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return new Error(body.error);
  } catch {
    // non-JSON body (e.g. an upstream 502 HTML page) — fall back to the status
  }
  return new Error(`${fallback}: ${res.status}`);
}

// ── the drive (DB-backed, content-addressed) ─────────────────────────────────

/** Shape of a file record returned by the API (an enriched FileWithVersion). */
interface ApiFile {
  id: string;
  name: string;
  metadata: Record<string, unknown>;
  updatedAt: string;
  deletedAt?: string | null;
  ownerLabel?: string;
  sharedWith?: string[];
  version: { size: number; mime: string | null } | null;
}
interface DriveListing {
  path: string;
  spaceName?: string;
  files: ApiFile[];
  folders: string[];
}

function toFileItem(f: ApiFile, dir: string, spaceName?: string): FileItem {
  return {
    id: f.id,
    name: f.name,
    kind: kindForName(f.name),
    modified: fmtDate(f.updatedAt),
    size: humanSize(f.version?.size),
    path: dir,
    sharedWith: f.sharedWith,
    owner: f.ownerLabel,
    location: spaceName,
    starred: !!f.metadata?.starred,
    labels: Array.isArray(f.metadata?.labels) ? (f.metadata.labels as string[]) : undefined,
    tags: Array.isArray(f.metadata?.tags) ? (f.metadata.tags as string[]) : undefined,
    description: typeof f.metadata?.description === "string" ? (f.metadata.description as string) : undefined,
    processing: Array.isArray(f.metadata?.processing) ? (f.metadata.processing as ProcessingEntry[]) : undefined,
  };
}

function toFileItems(data: DriveListing, dir: string): FileItem[] {
  const folders: FileItem[] = data.folders.map((name) => ({
    id: `folder:${join(dir, name)}`,
    name,
    kind: "folder",
    modified: "—",
    size: "—",
    path: join(dir, name),
  }));
  const files: FileItem[] = data.files.map((f) => toFileItem(f, dir, data.spaceName));
  return [...folders, ...files];
}

/** A mirror row is the same shape as an `ApiFile` minus the nested version — flatten
 *  it back so the existing `toFileItem` mapping renders it identically. */
function mirrorToFileItem(m: MirrorFile, dir: string): FileItem {
  return toFileItem(
    {
      id: m.id,
      name: m.name,
      metadata: m.metadata,
      updatedAt: m.updatedAt,
      ownerLabel: m.ownerLabel,
      sharedWith: m.sharedWith,
      version: m.size != null || m.mime != null ? { size: m.size ?? 0, mime: m.mime } : null,
    },
    dir,
  );
}

/** Build a folder's `FileItem[]` (folders first, then files) from a mirror folder view. */
function mirrorViewToItems(view: { files: MirrorFile[]; folders: string[] }, dir: string): FileItem[] {
  const folders: FileItem[] = view.folders.map((name) => ({
    id: `folder:${join(dir, name)}`,
    name,
    kind: "folder",
    modified: "—",
    size: "—",
    path: join(dir, name),
  }));
  return [...folders, ...view.files.map((f) => mirrorToFileItem(f, dir))];
}

/**
 * Fetch one file's metadata by id, as a `FileItem` (the same shape a listing
 * yields). Used to restore an open document from a `?file=` deep link when the
 * file isn't in the currently-loaded folder. Returns null if it's gone or the
 * caller can't read it (404/403) — callers treat that as "nothing to restore".
 */
export async function getFile(id: string): Promise<FileItem | null> {
  try {
    const res = await apiFetch(`/api/files/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    const f = (await res.json()) as ApiFile;
    const dir = typeof f.metadata?.path === "string" ? (f.metadata.path as string) : "";
    return toFileItem(f, dir);
  } catch {
    return null; // backend unreachable — the preview just won't restore
  }
}

/** One full-text search hit: the file (as a `FileItem`, openable in the preview) + a matched snippet. */
export interface SearchResult {
  file: FileItem;
  /** A highlighted excerpt around the match, when the backend produced one. */
  snippet?: string;
}

interface ApiSearchHit {
  id: string;
  spaceId: string;
  score: number;
  title: string;
  snippet?: string;
  kind?: string;
  path?: string;
  modifiedAt?: string;
}

/**
 * Full-text search across files the signed-in user can read (name, body, labels).
 * Backed by the server's `/api/search`; results are mapped into `FileItem`s so a
 * hit opens in the preview like any other file. Returns [] for blank queries or
 * when offline/unauthenticated.
 */
export async function searchFiles(q: string, limit = 8): Promise<SearchResult[]> {
  const query = q.trim();
  if (!query) return [];
  try {
    const res = await apiFetch(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: ApiSearchHit[] };
    return (data.items ?? []).map((h) => ({
      snippet: h.snippet,
      file: {
        id: h.id,
        name: h.title,
        kind: kindForName(h.title),
        modified: h.modifiedAt ? fmtDate(h.modifiedAt) : "—",
        size: "—",
        path: h.path ?? "",
      },
    }));
  } catch {
    return []; // backend unreachable → no results (the UI stays usable)
  }
}

/** List a virtual folder of a space (default: personal). Folders first, then files. */
export async function listFiles(dir = "", spaceId?: string, opts?: { fresh?: boolean }): Promise<FileItem[]> {
  const key = listingKey(spaceId, dir);
  const isConnector = String(spaceId ?? "").startsWith("connector:");
  // `fresh` (an explicit user refresh) tells the backend to skip its reconcile debounce
  // so a connector folder re-converges now instead of within the debounce window.
  const freshParam = opts?.fresh ? "&fresh=1" : "";
  // Mirror-first for EVERY space — personal, group, and connected (NAS/repo). Serve the
  // synced local replica instantly (works offline); the mirror diffs in the background.
  // Falls through to a one-off live fetch only when this space isn't synced yet.
  if (MIRROR_ENABLED) {
    try {
      const view = await mirrorFolder(dir, spaceId);
      if (view) {
        // A connected folder served from the mirror: kick a background reconcile so the
        // NAS/repo index stays fresh; its changes flow back into the mirror via the delta
        // (we ignore the response here).
        if (isConnector) {
          void apiFetch(`/api/files?path=${encodeURIComponent(dir)}&space=${encodeURIComponent(spaceId!)}${freshParam}`).catch(() => {});
        }
        const items = mirrorViewToItems(view, dir);
        await annotateOffline(items, spaceId); // mark pinned (available-offline) items
        void warmStarred(items, spaceId); // keep starred bytes available offline
        return items;
      }
    } catch {
      // fall through to the legacy network + listing-cache path
    }
  }
  const sp = spaceId ? `&space=${encodeURIComponent(spaceId)}` : "";
  try {
    const res = await apiFetch(`/api/files?path=${encodeURIComponent(dir)}${sp}${freshParam}`);
    if (res.status === 401) return []; // not signed in → empty drive
    if (!res.ok) throw await apiError(res, "list failed");
    const items = toFileItems(await res.json(), dir);
    await annotateOffline(items, spaceId); // mark pinned (available-offline) items
    void cacheListing(key, items); // for offline browsing (with their offline flags)
    void warmStarred(items, spaceId); // pre-fetch starred bytes so they open offline
    return items;
  } catch (err) {
    // Backend unreachable (or errored): serve the last-known copy if we have one.
    const cached = await readListing(key);
    if (cached) return cached;
    throw err;
  }
}

/** Files shared directly with the caller (outside their own spaces). */
export async function listShared(): Promise<FileItem[]> {
  const key = listingKey("shared", "");
  try {
    const res = await apiFetch("/api/files?shared=1");
    if (!res.ok) return [];
    const items = toFileItems(await res.json(), "");
    await annotateOffline(items, "shared"); // mark pinned (available-offline) items
    void cacheListing(key, items);
    return items;
  } catch {
    return (await readListing(key)) ?? [];
  }
}

/** URL to stream a file's current version. */
/** Fetch a file's current content as UTF-8 text (authenticated, connector-aware). */
export async function fetchFileText(id: string): Promise<string> {
  const res = await apiFetch(contentUrl(id));
  if (!res.ok) throw new Error(`load failed: ${res.status}`);
  return res.text();
}

export function contentUrl(id: string): string {
  // A connected space's file id is "connector:<plugin>:<repo-path>"; its bytes are
  // streamed live through the connector via the path-keyed /api/file route.
  if (id.startsWith("connector:")) {
    const rest = id.slice("connector:".length);
    const sep = rest.indexOf(":");
    const pluginId = rest.slice(0, sep);
    const path = rest.slice(sep + 1);
    return `/api/file?space=connector:${encodeURIComponent(pluginId)}&path=${encodeURIComponent(path)}`;
  }
  return `/api/files/${id}/content`;
}

/**
 * Trigger a real download (save dialog) rather than an in-tab preview.
 *
 * `window.open` lets the browser render previewable types (PDF, images, text)
 * inline, so it never saves them. We instead hit the content URL with
 * `?download` — the server replies `Content-Disposition: attachment` — and click
 * a hidden same-origin anchor whose `download` attribute names the file.
 */
export function downloadFile(id: string, name: string): void {
  const base = contentUrl(id);
  const url = base.includes("?") ? `${base}&download=1` : `${base}?download=1`;
  saveAs(url, name);
}

/** Trigger a download of a specific past version's bytes. */
export function downloadVersion(id: string, versionId: string, name: string): void {
  saveAs(versionContentUrl(id, versionId), name);
}

function saveAs(url: string, name: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Fetch a file's bytes for a viewer, transparently using the offline cache.
 * Online: streams from the API and stores a copy (this is what makes a viewed
 * file "recent" and available offline). Offline: serves the cached copy, or
 * re-throws if we never cached it. Keyed by the content URL.
 */
export async function fetchContent(url: string, space?: string): Promise<{ bytes: ArrayBuffer; mime: string }> {
  const spaceId = spaceForContentUrl(url, space);
  // Cache-FIRST (stale-while-revalidate): a previously-opened file opens instantly from
  // the cache — online or offline — instead of waiting on the network. When online and
  // reachable, we revalidate in the background with a conditional request (If-None-Match):
  // almost always a cheap 304 (Canopy is the single point of entry, so content rarely
  // changes underneath us), and on the rare real change we refresh the cache and notify
  // any open viewer to reload (see subscribeContentUpdate).
  const cached = await readContent(url);
  if (cached) {
    const online = typeof navigator === "undefined" || navigator.onLine;
    if (online && isBackendReachable()) void revalidateContent(url, spaceId, cached.etag);
    return { bytes: cached.bytes, mime: cached.mime };
  }
  // Not cached → must fetch (and store). Offline with no cached copy still throws.
  const res = await apiFetch(url);
  if (!res.ok) throw await apiError(res, "fetch failed");
  const bytes = await res.arrayBuffer();
  const mime = res.headers.get("content-type") ?? "application/octet-stream";
  const etag = res.headers.get("etag") ?? undefined;
  // Cache a copy — the original may be transferred to a sandboxed viewer. Tagged with its
  // space so the per-space cache budget can account for and evict it.
  void cacheContent(url, { bytes: bytes.slice(0), mime, name: "", size: bytes.byteLength, at: Date.now(), spaceId, etag });
  return { bytes, mime };
}

/** Background freshness check for a cached file: a conditional GET (If-None-Match). On
 *  304 nothing changed; on 200 the bytes changed — update the cache and notify open
 *  viewers. Best-effort: a failure (offline, NAS down) leaves the cached copy in place. */
async function revalidateContent(url: string, spaceId: string, etag?: string): Promise<void> {
  try {
    const res = await apiFetch(url, etag ? { headers: { "If-None-Match": etag } } : undefined);
    if (res.status === 304 || !res.ok) return; // unchanged, or transient error → keep cache
    const bytes = await res.arrayBuffer();
    const mime = res.headers.get("content-type") ?? "application/octet-stream";
    const newEtag = res.headers.get("etag") ?? undefined;
    if (newEtag && newEtag === etag) return; // same content (no validator change) — don't churn
    await cacheContent(url, { bytes, mime, name: "", size: bytes.byteLength, at: Date.now(), spaceId, etag: newEtag });
    // Only nudge an open viewer when a validator confirms the bytes actually changed
    // (newEtag present and ≠ the old one). Without an ETag we can't tell, so re-cache
    // silently rather than churning every viewer on each revalidation.
    if (newEtag) publishContentUpdate(url);
  } catch {
    // offline / backend unreachable — the cached copy stands
  }
}

// Content-update notifications: fetchContent's background revalidation fires these when a
// file's bytes change underneath an open viewer, so it can reload (the cache is already
// fresh by then). Keyed by content URL.
const contentListeners = new Map<string, Set<() => void>>();

/** Subscribe to "this file's cached content was refreshed" for a content URL. */
export function subscribeContentUpdate(url: string, cb: () => void): () => void {
  const set = contentListeners.get(url) ?? new Set<() => void>();
  set.add(cb);
  contentListeners.set(url, set);
  return () => {
    set.delete(cb);
    if (set.size === 0) contentListeners.delete(url);
  };
}

function publishContentUpdate(url: string): void {
  contentListeners.get(url)?.forEach((cb) => cb());
}

/** The space a content URL belongs to, for cache accounting. A connected space's URL
 *  embeds `space=connector:<plugin>` (authoritative); everything else falls back to the
 *  caller's current view space ("" = personal drive). */
function spaceForContentUrl(url: string, fallback?: string): string {
  const m = /[?&]space=([^&]+)/.exec(url);
  if (m) return decodeURIComponent(m[1]);
  return fallback ?? "";
}

/** Record an opened file as "recent" so its content is kept for offline use. */
export function rememberOpened(file: FileItem): void {
  if (file.kind === "folder") return;
  void rememberRecent(file.id);
}

/** Best-effort: pre-cache the bytes of starred files we just listed, for offline viewing. */
async function warmStarred(items: FileItem[], space?: string): Promise<void> {
  for (const f of items) {
    if (!f.starred || f.kind === "folder") continue;
    const url = contentUrl(f.id);
    if (await hasContent(url)) continue;
    try {
      const res = await apiFetch(url);
      if (!res.ok) continue;
      const bytes = await res.arrayBuffer();
      const mime = res.headers.get("content-type") ?? "application/octet-stream";
      const spaceId = spaceForContentUrl(url, space);
      await cacheContent(url, { bytes, mime, name: f.name, size: bytes.byteLength, at: Date.now(), spaceId });
    } catch {
      break; // network died mid-warm — stop trying
    }
  }
}

// ── available offline (per-device pins) ───────────────────────────────────────
// "Available offline" is a guarantee distinct from star (a synced bookmark) and from the
// per-space cache budget (an opportunistic LRU cap): a pinned file/folder is proactively
// downloaded and never evicted. The pin set lives client-side (see offline-cache.ts); these
// helpers annotate listings with the resulting state, toggle pins, and reconcile the cache.

/** Whether an item is currently kept offline: explicitly pinned, or under a pinned folder
 *  (a folder item is "offline" only when it is itself the pinned folder). `space` is the
 *  UI space token the listing was loaded for. */
function isOffline(pins: Pins, item: FileItem, space: string): boolean {
  const dir = item.path ?? "";
  if (item.kind === "folder") return pins.folders.some((f) => f.space === space && f.path === dir);
  if (pins.files.includes(item.id)) return true;
  return pins.folders.some(
    (f) => f.space === space && (f.path === "" || dir === f.path || dir.startsWith(f.path + "/")),
  );
}

/** Tag each item with its offline state for the current space (one pin-set read). */
async function annotateOffline(items: FileItem[], space?: string): Promise<FileItem[]> {
  const pins = await readPins();
  const sp = space ?? "";
  for (const it of items) it.offline = isOffline(pins, it, sp);
  return items;
}

/** Is this single item kept available offline? (For a viewer's own toggle.) */
export async function isItemOffline(item: FileItem, space?: string): Promise<boolean> {
  return isOffline(await readPins(), item, space ?? "");
}

/**
 * Pin or unpin a file/folder for offline use, then reconcile the cache. Folder pins are
 * recursive. Per-device and best-effort: the toggle persists immediately; the byte
 * download happens in `reconcilePins` and silently retries on the next trigger if offline.
 */
export async function setItemOffline(item: FileItem, space: string | undefined, on: boolean): Promise<void> {
  if (item.kind === "folder") await setFolderPinned(space, item.path ?? "", on);
  else await setFilePinned(item.id, on);
  // The pin (intent) is now persisted — that's what the badge reflects. Sync the actual
  // bytes in the background so the toggle returns immediately even for large files/folders.
  void reconcilePins();
}

/**
 * Make the content cache match the pin set: download + protect (flag `pinned`) the bytes of
 * every pinned file — expanding folder pins through the local mirror — and release anything
 * no longer pinned so the budget can reclaim it. Idempotent; safe to call on every sync.
 * Best-effort: a fetch failure leaves that file to warm on the next pass (or next open).
 */
export async function reconcilePins(): Promise<void> {
  const pins = await readPins();
  // Resolve every pinned target to its content URL (the cache key), with the space + name
  // we know, deduped (a file pinned directly and via its folder is one entry).
  const wanted = new Map<string, { space: string; name: string }>();
  for (const id of pins.files) {
    const url = contentUrl(id);
    wanted.set(url, { space: spaceForContentUrl(url), name: "" });
  }
  let folderRows = 0;
  for (const f of pins.folders) {
    const rows = await mirrorFilesUnder(f.space, f.path);
    folderRows += rows.length;
    for (const row of rows) {
      const url = contentUrl(row.id);
      wanted.set(url, { space: f.space || spaceForContentUrl(url), name: row.name });
    }
  }
  // Mirror not ready yet (folder pins exist but resolved to nothing): protect what we can
  // but skip the release pass, so already-pinned bytes aren't unprotected in the window
  // before the post-sync reconcile re-expands the folders.
  const mirrorPending = pins.folders.length > 0 && folderRows === 0;
  // Protect what's pinned: keep already-cached bytes (just flag them), fetch the rest.
  for (const [url, info] of wanted) {
    try {
      if (await hasContent(url)) {
        await markContentPinned(url, true);
        continue;
      }
      const res = await apiFetch(url);
      if (!res.ok) continue;
      const bytes = await res.arrayBuffer();
      const mime = res.headers.get("content-type") ?? "application/octet-stream";
      const etag = res.headers.get("etag") ?? undefined;
      await cacheContent(url, {
        bytes,
        mime,
        name: info.name,
        size: bytes.byteLength,
        at: Date.now(),
        spaceId: info.space,
        etag,
        pinned: true,
      });
    } catch {
      break; // offline mid-reconcile — stop; the next trigger retries
    }
  }
  // Release everything else that was pinned (it becomes evictable again).
  if (!mirrorPending) await unpinContentExcept(new Set(wanted.keys()));
}

/** Store bytes content-addressed in a space, skipping the upload if it already exists. Returns the hash. */
async function uploadBlob(bytes: Uint8Array, spaceId?: string): Promise<string> {
  const sp = spaceId ? `?space=${encodeURIComponent(spaceId)}` : "";
  const hash = await sha256hex(bytes);
  const prep = await apiFetch(`/api/uploads/prepare${sp}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hash, size: bytes.byteLength }),
  });
  if (!prep.ok) throw new Error(`prepare failed: ${prep.status}`);
  const { exists } = (await prep.json()) as { exists: boolean };
  if (!exists) {
    const put = await apiFetch(`/api/uploads/${hash}${sp}`, { method: "PUT", body: bytes as unknown as BodyInit });
    if (!put.ok) throw new Error(`upload failed: ${put.status}`);
  }
  return hash;
}

/**
 * Store bytes for an existing file's next version. Keyed server-side to the
 * file's own space (not whatever space is active in the UI), so the version POST
 * always finds the blob — even for a file shared from another space. Returns the hash.
 */
async function uploadFileBlob(id: string, bytes: Uint8Array): Promise<string> {
  const hash = await sha256hex(bytes);
  const prep = await apiFetch(`/api/files/${id}/uploads/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hash, size: bytes.byteLength }),
  });
  if (!prep.ok) throw new Error(`prepare failed: ${prep.status}`);
  const { exists } = (await prep.json()) as { exists: boolean };
  if (!exists) {
    const put = await apiFetch(`/api/files/${id}/uploads/${hash}`, { method: "PUT", body: bytes as unknown as BodyInit });
    if (!put.ok) throw new Error(`upload failed: ${put.status}`);
  }
  return hash;
}

/** Upload files into a virtual folder of a space: hash → dedup-prepare → (PUT if new) → create record. */
export async function uploadFiles(dir: string, files: File[], spaceId?: string): Promise<number> {
  // A connected space (a NAS) is the source of truth, not the managed blob store:
  // stream the bytes straight to the connector, which writes + reconciles the index.
  if (spaceId?.startsWith("connector:")) {
    for (const file of files) {
      const path = dir ? `${dir}/${file.name}` : file.name;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const res = await apiFetch(
        `/api/connector-files?space=${encodeURIComponent(spaceId)}&path=${encodeURIComponent(path)}`,
        { method: "PUT", body: bytes as unknown as BodyInit },
      );
      if (!res.ok) throw new Error(`upload failed: ${res.status}`);
    }
    return files.length;
  }
  const sp = spaceId ? `?space=${encodeURIComponent(spaceId)}` : "";
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await uploadBlob(bytes, spaceId);
    const res = await apiFetch(`/api/files${sp}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: file.name, hash, mime: file.type || undefined, path: dir }),
    });
    if (!res.ok) throw new Error(`create failed: ${res.status}`);
  }
  return files.length;
}

/**
 * Create a new text file in a folder, seeded with `content` (a plugin creator's
 * template, possibly empty). Uploads the blob, creates the record, and returns
 * the new file as a FileItem so the caller can open it straight in its editor.
 */
export async function createFile(
  dir: string,
  name: string,
  content: string,
  mime = "text/markdown",
  spaceId?: string,
): Promise<FileItem> {
  let res: Response;
  if (spaceId?.startsWith("connector:")) {
    // Connected space (a NAS): write the seeded bytes through the connector, which
    // reconciles and returns the new file row (with its real id) to open in-editor.
    const path = dir ? `${dir}/${name}` : name;
    res = await apiFetch(
      `/api/connector-files?space=${encodeURIComponent(spaceId)}&path=${encodeURIComponent(path)}`,
      { method: "PUT", body: new TextEncoder().encode(content) as unknown as BodyInit },
    );
  } else {
    const sp = spaceId ? `?space=${encodeURIComponent(spaceId)}` : "";
    const hash = await uploadBlob(new TextEncoder().encode(content), spaceId);
    res = await apiFetch(`/api/files${sp}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, hash, mime, path: dir }),
    });
  }
  if (!res.ok) throw new Error(`create failed: ${res.status}`);
  const f = (await res.json()) as ApiFile;
  return {
    id: f.id,
    name: f.name,
    kind: kindForName(f.name),
    modified: fmtDate(f.updatedAt),
    size: humanSize(f.version?.size),
    path: dir,
  };
}

/**
 * Save new text content as a NEW version of a file (metadata untouched). The blob
 * is staged file-scoped, so it lands in the file's own space regardless of which
 * space is active in the UI. This is an explicit user Save, so `coalesce: false`
 * forces a discrete version rather than merging into the current editing-session window.
 */
export async function saveFileVersion(id: string, text: string, mime = "text/markdown"): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  const hash = await uploadFileBlob(id, bytes);
  const res = await apiFetch(`/api/files/${id}/versions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hash, mime, coalesce: false }),
  });
  if (!res.ok) throw new Error(`save failed: ${res.status}`);
}

/** One entry in a file's version history (newest first from the API). */
export interface FileVersion {
  id: string;
  size: number;
  mime: string | null;
  source: "blob" | "external";
  createdAt: string;
  createdBy: string;
  createdByLabel: string;
  /** Pinned: retention never prunes a kept version. */
  keep: boolean;
}

/** A file's version history, newest first (the first entry is the current version). */
export async function listVersions(id: string): Promise<FileVersion[]> {
  const res = await apiFetch(`/api/files/${id}/versions`);
  if (!res.ok) return [];
  return (await res.json()) as FileVersion[];
}

/** URL to download a specific past version's bytes (served as an attachment). */
export function versionContentUrl(id: string, versionId: string): string {
  return `/api/files/${id}/versions/${versionId}/content`;
}

/** Pin or unpin a version so retention/pruning never removes it. */
export async function setVersionKeep(id: string, versionId: string, keep: boolean): Promise<void> {
  const res = await apiFetch(`/api/files/${id}/versions/${versionId}/keep`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keep }),
  });
  if (!res.ok) throw new Error(`keep version failed: ${res.status}`);
}

/** Restore an older version — appends its content as the new current version. */
export async function restoreVersion(id: string, versionId: string): Promise<void> {
  const res = await apiFetch(`/api/files/${id}/versions/${versionId}/restore`, { method: "POST" });
  if (!res.ok) throw new Error(`restore version failed: ${res.status}`);
}

/** Move a drive file to Trash (recoverable). */
export async function deleteFile(id: string): Promise<void> {
  const res = await apiFetch(`/api/files/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed: ${res.status}`);
}

/** Re-run the processing pipeline for a file: re-extract text, re-index for search,
 *  and re-run AI document processors (labels/description). The AI pass runs server-side
 *  off the response path, so this resolves once the re-index is queued. */
export async function reprocessFile(id: string): Promise<void> {
  const res = await apiFetch(`/api/files/${id}/reprocess`, { method: "POST" });
  if (!res.ok) throw new Error(`reprocess failed: ${res.status}`);
}

/** Files in the caller's Trash, newest deletion first. */
export async function listTrash(): Promise<FileItem[]> {
  const res = await apiFetch("/api/files?trash=1");
  if (res.status === 401) return [];
  if (!res.ok) throw new Error(`trash failed: ${res.status}`);
  const data = (await res.json()) as DriveListing;
  return data.files.map((f) => ({
    id: f.id,
    name: f.name,
    kind: kindForName(f.name),
    modified: fmtDate(f.deletedAt ?? f.updatedAt),
    size: humanSize(f.version?.size),
    path: "",
    owner: f.ownerLabel,
  }));
}

/** Restore a file from Trash. */
export async function restoreFile(id: string): Promise<void> {
  const res = await apiFetch(`/api/files/${id}/restore`, { method: "POST" });
  if (!res.ok) throw new Error(`restore failed: ${res.status}`);
}

/** Permanently delete a file and its content (irreversible). */
export async function purgeFile(id: string): Promise<void> {
  const res = await apiFetch(`/api/files/${id}?permanent=1`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed: ${res.status}`);
}

/** Star/unstar a file — persisted as `metadata.starred` (a metadata edit, no new version). */
export async function setStarred(id: string, starred: boolean): Promise<void> {
  const res = await apiFetch(`/api/files/${id}/metadata`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ starred }),
  });
  if (!res.ok) throw new Error(`star failed: ${res.status}`);
}

/** Set a file's user tags — persisted as `metadata.tags` (distinct from AI `labels`; no new version). */
export async function setTags(id: string, tags: string[]): Promise<void> {
  const res = await apiFetch(`/api/files/${id}/metadata`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tags }),
  });
  if (!res.ok) throw new Error(`set tags failed: ${res.status}`);
}

/** Set a file's description — persisted as `metadata.description` (a metadata edit, no new version). */
export async function setDescription(id: string, description: string): Promise<void> {
  const res = await apiFetch(`/api/files/${id}/metadata`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description }),
  });
  if (!res.ok) throw new Error(`set description failed: ${res.status}`);
}

// ── comments (a discussion thread on a file) ──────────────────────────────────

export interface Comment {
  id: string;
  authorId: string;
  authorLabel: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

/** A file's comments, oldest first. Empty when the caller can't see the file. */
export async function listComments(fileId: string): Promise<Comment[]> {
  const res = await apiFetch(`/api/files/${fileId}/comments`);
  if (!res.ok) return [];
  return (await res.json()) as Comment[];
}

/** Post a comment on a file. */
export async function addComment(fileId: string, body: string): Promise<Comment> {
  const res = await apiFetch(`/api/files/${fileId}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`add comment failed: ${res.status}`);
  return (await res.json()) as Comment;
}

/** Delete a comment (author or file owner only). */
export async function deleteComment(fileId: string, commentId: string): Promise<void> {
  const res = await apiFetch(`/api/files/${fileId}/comments/${commentId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete comment failed: ${res.status}`);
}

/** Move a file into a virtual folder — persisted as `metadata.path` (a metadata edit, no new version). */
export async function moveFile(id: string, path: string): Promise<void> {
  const res = await apiFetch(`/api/files/${id}/metadata`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(`move failed: ${res.status}`);
}

/** Rename a file — persisted as the file's `name` column (a metadata edit, no new version). */
export async function renameFile(id: string, name: string): Promise<void> {
  const res = await apiFetch(`/api/files/${id}/metadata`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`rename failed: ${res.status}`);
}

/** Create an empty folder at a virtual path within a space. */
export async function createFolder(path: string, spaceId?: string): Promise<void> {
  const sp = spaceId ? `?space=${encodeURIComponent(spaceId)}` : "";
  const res = await apiFetch(`/api/folders${sp}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(`create folder failed: ${res.status}`);
}

export interface Overview {
  files: number;
  bytes: number;
}

/** File count + bytes used in a space (for the dashboard). */
export async function getOverview(spaceId?: string): Promise<Overview> {
  const sp = spaceId ? `?space=${encodeURIComponent(spaceId)}` : "";
  const res = await apiFetch(`/api/overview${sp}`);
  if (!res.ok) return { files: 0, bytes: 0 };
  return (await res.json()) as Overview;
}

// ── spaces + sharing ─────────────────────────────────────────────────────────

export type Role = "owner" | "editor" | "viewer";

export interface SpaceView {
  id: string;
  name: string;
  kind: "personal" | "group" | "connected";
  role: Role;
  mounted: boolean;
  /** A read-only space (e.g. a connected GitHub repo): no uploads, edits, or sharing. */
  readonly?: boolean;
  /** Optional sidebar icon name (falls back to the people icon). */
  icon?: string | null;
  /** Optional accent color — an HSL triplet like "145 33% 36%". */
  color?: string | null;
}

/** Spaces the caller can see, with their role + mount preference. */
export async function listSpaces(): Promise<SpaceView[]> {
  const res = await apiFetch("/api/spaces");
  if (!res.ok) return [];
  return (await res.json()) as SpaceView[];
}

/**
 * Actively test a connector-backed plugin's connection (Synology, etc.). A saved
 * config makes a `connector:<id>` space *appear*, but that alone doesn't mean the
 * backend is reachable — this hits `/api/plugins/:id/test`, which builds the
 * connector and tries a root listing, so a plugin page can show the real failure.
 */
export async function testConnector(pluginId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`/api/plugins/${encodeURIComponent(pluginId)}/test`);
    if (res.status === 401) return { ok: false, error: "Sign in to test the connection." };
    if (!res.ok) return { ok: false, error: `test failed: ${res.status}` };
    return (await res.json()) as { ok: boolean; error?: string };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Force a full reconcile of a connector-backed space (the "Sync now" action):
 * crawl the whole tree + (re)index its text, bypassing the lazy-view debounce. The
 * work runs in the background on the server; this just kicks it off.
 */
export async function syncConnector(pluginId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`/api/connector/${encodeURIComponent(pluginId)}/sync`, { method: "POST" });
    if (res.status === 401) return { ok: false, error: "Sign in to sync." };
    if (!res.ok) return { ok: false, error: `sync failed: ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export interface ConnectorStatus {
  /** A crawl is running, or extraction is still draining — the space is "still loading". */
  indexing: boolean;
  /** Files still awaiting text extraction; ticks down as indexing progresses. */
  pending: number;
  /** ISO time of the last completed crawl, or null if never indexed. */
  lastIndexedAt: string | null;
}

const NOT_INDEXING: ConnectorStatus = { indexing: false, pending: 0, lastIndexedAt: null };

/**
 * Indexing state of a connector-backed space. DB-only on the server (no NAS/repo
 * round-trip), so the sidebar can poll it cheaply. Any failure resolves to
 * "not indexing" rather than throwing — a status hint must never wedge the sidebar.
 */
export async function connectorStatus(pluginId: string): Promise<ConnectorStatus> {
  try {
    const res = await apiFetch(`/api/connector/${encodeURIComponent(pluginId)}/status`);
    if (!res.ok) return NOT_INDEXING;
    return (await res.json()) as ConnectorStatus;
  } catch {
    return NOT_INDEXING;
  }
}

/** Version-retention policy of a connected space (matches the store's `VersionPolicyKind`). */
export type VersionPolicy = "all" | "smart" | "days";
export interface ConnectorSettings {
  versionPolicy: VersionPolicy;
  /** Day window when `versionPolicy === "days"` (else null). The server names it `days`. */
  versionDays: number | null;
}

/** Same-origin URL of a connector's live indexing-log SSE stream (for `EventSource`). */
export function connectorLogStreamUrl(pluginId: string): string {
  return `/api/connector/${encodeURIComponent(pluginId)}/logs/stream`;
}

/** Read a connected space's version-retention policy. */
export async function getConnectorSettings(pluginId: string): Promise<ConnectorSettings> {
  const res = await apiFetch(`/api/connector/${encodeURIComponent(pluginId)}/settings`);
  if (!res.ok) throw new Error(`load settings failed: ${res.status}`);
  const raw = (await res.json()) as { policy: VersionPolicy; days: number | null };
  return { versionPolicy: raw.policy, versionDays: raw.days };
}

/** Set a connected space's version-retention policy (owner only on the server). */
export async function setConnectorSettings(
  pluginId: string,
  versionPolicy: VersionPolicy,
  versionDays: number | null,
): Promise<ConnectorSettings> {
  const res = await apiFetch(`/api/connector/${encodeURIComponent(pluginId)}/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ versionPolicy, versionDays }),
  });
  if (!res.ok) throw new Error(`save settings failed: ${res.status}`);
  const raw = (await res.json()) as { policy: VersionPolicy; days: number | null };
  return { versionPolicy: raw.policy, versionDays: raw.days };
}

// ── connected-space branches (a GitHub repo's refs) ──────────────────────────

/** One branch of a connected repo (mirrors the core `BranchInfo`). */
export interface BranchInfo {
  name: string;
  isDefault: boolean;
  current: boolean;
  protected?: boolean;
  commitSha?: string;
}

export interface BranchListing {
  /** False when this connector has no branch concept (a NAS) — show no picker. */
  supported: boolean;
  /** The branch the space is rooted at, or null. */
  current: string | null;
  /** Whether the caller can persist a branch switch (only with their own config). */
  canSwitch: boolean;
  branches: BranchInfo[];
}

const NO_BRANCHES: BranchListing = { supported: false, current: null, canSwitch: false, branches: [] };

/** List a connected space's branches. Resolves to "unsupported" on any failure so a
 *  non-GitHub space (or an unreachable repo) simply shows no branch picker. */
export async function listBranches(pluginId: string): Promise<BranchListing> {
  try {
    const res = await apiFetch(`/api/connector/${encodeURIComponent(pluginId)}/branches`);
    if (!res.ok) return NO_BRANCHES;
    return (await res.json()) as BranchListing;
  } catch {
    return NO_BRANCHES;
  }
}

/** Switch the branch the connected space is rooted at (persists + re-indexes server-side). */
export async function switchBranch(pluginId: string, branch: string): Promise<void> {
  const res = await apiFetch(`/api/connector/${encodeURIComponent(pluginId)}/branch`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ branch }),
  });
  if (!res.ok) throw await apiError(res, "switch branch failed");
}

/** Create a branch on the backend, optionally from a given base ref (default: current). */
export async function createBranch(pluginId: string, name: string, from?: string): Promise<void> {
  const res = await apiFetch(`/api/connector/${encodeURIComponent(pluginId)}/branches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, from }),
  });
  if (!res.ok) throw await apiError(res, "create branch failed");
}

/** Delete a branch on the backend. */
export async function deleteBranch(pluginId: string, name: string): Promise<void> {
  const res = await apiFetch(
    `/api/connector/${encodeURIComponent(pluginId)}/branches?name=${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw await apiError(res, "delete branch failed");
}

/** Create a shared (group) space, optionally with a sidebar icon + accent color. */
export async function createSpace(
  name: string,
  opts: { icon?: string | null; color?: string | null } = {},
): Promise<{ id: string; name: string; icon: string | null; color: string | null }> {
  const res = await apiFetch("/api/spaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, icon: opts.icon ?? null, color: opts.color ?? null }),
  });
  if (!res.ok) throw new Error(`create space failed: ${res.status}`);
  return (await res.json()) as { id: string; name: string; icon: string | null; color: string | null };
}

/** Rename a space (owner only). */
export async function renameSpace(spaceId: string, name: string): Promise<void> {
  const res = await apiFetch(`/api/spaces/${spaceId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`rename space failed: ${res.status}`);
}

/** Permanently delete a space and everything in it (owner only). Irreversible. */
export async function deleteSpace(spaceId: string): Promise<void> {
  const res = await apiFetch(`/api/spaces/${spaceId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete space failed: ${res.status}`);
}

/** Pin/unpin a space into My Drive. */
export async function setSpaceMounted(spaceId: string, mounted: boolean): Promise<void> {
  await apiFetch(`/api/spaces/${spaceId}/prefs`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mounted }),
  });
}

export interface AppPassword {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listAppPasswords(): Promise<AppPassword[]> {
  const res = await apiFetch("/api/app-passwords");
  if (!res.ok) return [];
  return (await res.json()) as AppPassword[];
}

/** Create an app password; returns the plaintext token ONCE. */
export async function createAppPassword(name: string): Promise<{ id: string; token: string }> {
  const res = await apiFetch("/api/app-passwords", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status}`);
  return (await res.json()) as { id: string; token: string };
}

export async function deleteAppPassword(id: string): Promise<void> {
  await apiFetch(`/api/app-passwords/${id}`, { method: "DELETE" });
}

/** An AI assistant (Claude, ChatGPT, an editor) connected over the MCP server. */
export interface McpConnection {
  /** The connecting app's id (token client id, or a slug of its clientInfo name). */
  clientId: string;
  /** Friendly name from the MCP handshake (e.g. "Claude"), or null if not learned. */
  name: string | null;
  version: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Assistants the signed-in user has connected to their drive, most recent first. */
export async function listMcpConnections(): Promise<McpConnection[]> {
  try {
    const res = await apiFetch("/api/mcp/connections");
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    return Array.isArray(data) ? (data as McpConnection[]) : [];
  } catch {
    return [];
  }
}

/** A share link (the unguessable secret is never returned after creation). */
export interface ShareLink {
  id: string;
  objectType: "file" | "folder" | "space";
  spaceId: string;
  fileId: string | null;
  path: string;
  role: "viewer" | "editor";
  label: string | null;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

/** What a share targets: a file, a folder (space + path), or a whole space. */
export type ShareTarget =
  | { kind: "file"; fileId: string }
  | { kind: "folder"; spaceId: string; path: string }
  | { kind: "space"; spaceId: string };

const sharesUrl = (t: ShareTarget, query = false): string => {
  if (t.kind === "file") return `/api/files/${t.fileId}/shares`;
  const q = t.kind === "folder" && query ? `?path=${encodeURIComponent(t.path)}` : "";
  return `/api/spaces/${t.spaceId}/shares${q}`;
};

export async function listShares(t: ShareTarget): Promise<ShareLink[]> {
  const res = await apiFetch(sharesUrl(t, true));
  if (!res.ok) return [];
  return (await res.json()) as ShareLink[];
}

/** Create a share link; returns the plaintext secret ONCE. */
export async function createShare(
  t: ShareTarget,
  opts: { role: "viewer" | "editor"; label?: string; expiresAt?: string | null },
): Promise<{ id: string; secret: string }> {
  const body: Record<string, unknown> = { ...opts };
  if (t.kind === "folder") body.path = t.path;
  const res = await apiFetch(sharesUrl(t), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `create failed: ${res.status}`);
  return (await res.json()) as { id: string; secret: string };
}

export async function revokeShare(id: string): Promise<void> {
  await apiFetch(`/api/shares/${id}`, { method: "DELETE" });
}

export interface Member {
  sub: string;
  role: Role;
  email: string | null;
  name: string | null;
  /** A pending email invite (the person hasn't signed in yet). */
  pending: boolean;
}

export async function listMembers(spaceId: string): Promise<Member[]> {
  const res = await apiFetch(`/api/spaces/${spaceId}/members`);
  if (!res.ok) throw new Error(`members failed: ${res.status}`);
  return (await res.json()) as Member[];
}

/** Add a member by email. Returns the member (or a pending invite if they have no account yet). */
export async function addMember(spaceId: string, email: string, role: Role): Promise<Member> {
  const res = await apiFetch(`/api/spaces/${spaceId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `add member failed: ${res.status}`);
  return (await res.json()) as Member;
}

/** Remove a member or pending invite by principal (a user sub or an invited email). */
export async function removeMember(spaceId: string, principal: string): Promise<void> {
  const res = await apiFetch(`/api/spaces/${spaceId}/members/remove`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sub: principal }),
  });
  if (!res.ok) throw new Error(`remove member failed: ${res.status}`);
}

// ── invite links (single-use) ─────────────────────────────────────────────────

export interface SpaceInvite {
  token: string;
  spaceId: string;
  role: Role;
  createdAt: string;
  expiresAt: string | null;
}

export type InviteStatus = "valid" | "used" | "expired" | "not_found";

export interface InviteInfo {
  status: InviteStatus;
  spaceId?: string;
  spaceName?: string;
  role?: Role;
}

/** The shareable URL for an invite token. */
export function inviteUrl(token: string): string {
  return `${window.location.origin}/?invite=${encodeURIComponent(token)}`;
}

/** Mint a single-use invite link for a space at a role. Owner only. */
export async function createInvite(spaceId: string, role: Role): Promise<SpaceInvite> {
  const res = await apiFetch(`/api/spaces/${spaceId}/invites`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `create invite failed: ${res.status}`);
  return (await res.json()) as SpaceInvite;
}

/** Active (unused, unexpired) invite links for a space. */
export async function listInvites(spaceId: string): Promise<SpaceInvite[]> {
  const res = await apiFetch(`/api/spaces/${spaceId}/invites`);
  if (!res.ok) return [];
  return (await res.json()) as SpaceInvite[];
}

/** Revoke an invite link before it's used. */
export async function revokeInvite(spaceId: string, token: string): Promise<void> {
  const res = await apiFetch(`/api/spaces/${spaceId}/invites/${encodeURIComponent(token)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`revoke invite failed: ${res.status}`);
}

/** Preview an invite link — what space/role it grants and whether it's still valid. No sign-in needed. */
export async function getInvite(token: string): Promise<InviteInfo> {
  const res = await apiFetch(`/api/invites/${encodeURIComponent(token)}`);
  if (!res.ok) return { status: "not_found" };
  return (await res.json()) as InviteInfo;
}

/** Redeem an invite link — the signed-in account joins the space. */
export async function acceptInvite(token: string): Promise<{ spaceId: string; alreadyMember: boolean }> {
  const res = await apiFetch(`/api/invites/${encodeURIComponent(token)}/accept`, { method: "POST" });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `accept invite failed: ${res.status}`);
  return (await res.json()) as { spaceId: string; alreadyMember: boolean };
}

/** A space the signed-in user has been invited to by email but hasn't joined yet. */
export interface PendingInvite {
  spaceId: string;
  spaceName: string;
  role: Role;
}

/** Spaces the caller was invited to by email that haven't resolved yet (for the banner). */
export async function listPendingInvites(): Promise<PendingInvite[]> {
  const res = await apiFetch("/api/invites/pending");
  if (!res.ok) return [];
  // Only trust an array shape: a stale/misrouted server can answer 200 with a
  // non-array body (e.g. the `:token` route's `{status}` object), and the banner
  // treats `.length` as the count — a non-array would slip past its empty-guard.
  const data = await res.json().catch(() => null);
  return Array.isArray(data) ? (data as PendingInvite[]) : [];
}

/** Claim all pending email invites for the signed-in (verified) account. */
export async function acceptPendingInvites(): Promise<{ accepted: number }> {
  const res = await apiFetch("/api/invites/pending/accept", { method: "POST" });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `accept failed: ${res.status}`);
  return (await res.json()) as { accepted: number };
}

export interface Grant {
  relation: Role;
  subjectType: "user" | "space" | "email";
  subjectId: string;
  subjectRelation?: string;
  /** Directory info for a resolved `user` subject (so we don't show the raw sub). */
  name?: string | null;
  /** Address for a `user` (from the directory) or `email` (the address itself) subject. */
  email?: string | null;
  picture?: string | null;
}

/** A person the caller is connected to (space co-member or file-share peer). */
export interface Person {
  sub: string;
  email: string | null;
  name: string | null;
  picture: string | null;
}

/** Connected people matching `q` (space co-members + file-share peers) — for the share picker. */
export async function searchPeople(q: string): Promise<Person[]> {
  const res = await apiFetch(`/api/people?q=${encodeURIComponent(q)}`);
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  return Array.isArray(data) ? (data as Person[]) : [];
}

/** Current grants on a file (for the Share dialog). */
export async function listGrants(fileId: string): Promise<Grant[]> {
  const res = await apiFetch(`/api/files/${fileId}/grants`);
  if (!res.ok) throw new Error(`grants failed: ${res.status}`);
  return (await res.json()) as Grant[];
}

/** Share a file with a person (by email) or a space, at a role. */
export async function shareFile(
  fileId: string,
  subject: { subjectType: "user" | "space" | "email"; subjectId: string },
  role: Role,
): Promise<void> {
  const res = await apiFetch(`/api/files/${fileId}/grants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...subject, role }),
  });
  if (!res.ok) throw new Error(`share failed: ${res.status}`);
}

/** Revoke a grant. */
export async function unshareFile(fileId: string, grant: Grant): Promise<void> {
  const res = await apiFetch(`/api/files/${fileId}/grants/unshare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // The backend expects `role` (matching the POST shape); a Grant names it `relation`.
    body: JSON.stringify({
      subjectType: grant.subjectType,
      subjectId: grant.subjectId,
      role: grant.relation,
      subjectRelation: grant.subjectRelation,
    }),
  });
  if (!res.ok) throw new Error(`unshare failed: ${res.status}`);
}

/** Grants on a folder (space + path) and its subtree — the folder-level mirror of file grants. */
export async function listFolderGrants(spaceId: string, path: string): Promise<Grant[]> {
  const res = await apiFetch(`/api/spaces/${spaceId}/folder-grants?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`grants failed: ${res.status}`);
  return (await res.json()) as Grant[];
}

export async function shareFolder(
  spaceId: string,
  path: string,
  subject: { subjectType: "user" | "space" | "email"; subjectId: string },
  role: Role,
): Promise<void> {
  const res = await apiFetch(`/api/spaces/${spaceId}/folder-grants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...subject, role, path }),
  });
  if (!res.ok) throw new Error(`share failed: ${res.status}`);
}

export async function unshareFolder(spaceId: string, path: string, grant: Grant): Promise<void> {
  const res = await apiFetch(`/api/spaces/${spaceId}/folder-grants/unshare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path,
      subjectType: grant.subjectType,
      subjectId: grant.subjectId,
      role: grant.relation,
      subjectRelation: grant.subjectRelation,
    }),
  });
  if (!res.ok) throw new Error(`unshare failed: ${res.status}`);
}

// ── read-only mounts (documentation / demo) ──────────────────────────────────

function mountEntryToItem(mount: string, e: StorageEntry): FileItem {
  return {
    id: `${mount}:${e.path}`,
    name: e.name,
    kind: e.kind === "folder" ? "folder" : kindForName(e.name),
    modified: fmtDate(e.modifiedAt),
    size: e.kind === "folder" ? "—" : humanSize(e.size),
    path: e.path,
  };
}

/** List a read-only mount (e.g. the documentation mount). */
export async function listMount(path: string, mount: string): Promise<FileItem[]> {
  const res = await apiFetch(`/api/files?mount=${mount}&path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  const page: Page<StorageEntry> = await res.json();
  return page.items.map((e) => mountEntryToItem(mount, e));
}

/** URL for a file on a read-only mount. */
export function mountFileUrl(path: string, mount: string): string {
  return `/api/file?mount=${mount}&path=${encodeURIComponent(path)}`;
}

export async function readText(path: string, mount: string): Promise<string> {
  const res = await apiFetch(mountFileUrl(path, mount));
  if (!res.ok) throw new Error(`read failed: ${res.status}`);
  return res.text();
}

// ── auth ─────────────────────────────────────────────────────────────────────

export interface AuthUser {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
}

export interface Me {
  user: AuthUser | null;
  authConfigured: boolean;
  /** Set when this is a last-known value served because the API was unreachable. */
  offline?: boolean;
}

export async function fetchMe(): Promise<Me> {
  try {
    const res = await apiFetch("/api/auth/me");
    if (!res.ok) return { user: null, authConfigured: false };
    const me = (await res.json()) as Me;
    void cacheMe(me); // remember the identity for offline reloads
    return me;
  } catch {
    // The API is unreachable — crucially NOT "auth is unconfigured". Falling back
    // to authConfigured:false here would render the demo persona; instead reuse
    // the last-known identity (flagged offline), and otherwise report a signed-out
    // *configured* app so the UI shows an offline/login state, never demo mode.
    const cached = await readMe<Me>();
    if (cached) return { ...cached, offline: true };
    return { user: null, authConfigured: true, offline: true };
  }
}

// ── installed plugins (persisted per user) ────────────────────────────────────

/**
 * The caller's persisted installed-plugin set, or `null` when it can't be
 * resolved (anonymous → 401, or the API is down) so the caller can fall back to
 * its own default. The server applies the per-user default when nothing is saved.
 */
export async function fetchInstalledPlugins(): Promise<string[] | null> {
  try {
    const res = await apiFetch("/api/plugins/installed");
    if (!res.ok) return null;
    const data = (await res.json()) as { ids?: unknown };
    return Array.isArray(data.ids) ? data.ids.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

/** Persist the full installed-plugin set. Throws on failure (e.g. anonymous). */
export async function saveInstalledPlugins(ids: string[]): Promise<void> {
  const res = await apiFetch("/api/plugins/installed", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(`save installed plugins failed: ${res.status}`);
}

/**
 * The caller's *effective* active set: their own installs unioned with every
 * plugin an owner applied to a space they belong to. This is what the sidebar /
 * rail / context menus render from. `null` when it can't be resolved (anonymous).
 */
export async function fetchActivePlugins(): Promise<string[] | null> {
  try {
    const res = await apiFetch("/api/plugins/active");
    if (!res.ok) return null;
    const data = (await res.json()) as { ids?: unknown };
    return Array.isArray(data.ids) ? data.ids.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

// ── per-space applied plugins (owner-managed; active for every member) ────────

/** Plugin ids applied to a space (any member can read). */
export async function getSpacePlugins(spaceId: string): Promise<string[]> {
  const res = await apiFetch(`/api/spaces/${encodeURIComponent(spaceId)}/plugins`);
  if (!res.ok) return [];
  const data = (await res.json()) as { ids?: unknown };
  return Array.isArray(data.ids) ? data.ids.filter((x): x is string => typeof x === "string") : [];
}

/** Apply a plugin to a space (owner only). Throws on failure (e.g. 403). */
export async function applySpacePlugin(spaceId: string, pluginId: string): Promise<void> {
  const res = await apiFetch(`/api/spaces/${encodeURIComponent(spaceId)}/plugins`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pluginId }),
  });
  if (!res.ok) throw new Error(`apply plugin failed: ${res.status}`);
}

/** Remove a plugin from a space (owner only). Throws on failure. */
export async function removeSpacePlugin(spaceId: string, pluginId: string): Promise<void> {
  const res = await apiFetch(
    `/api/spaces/${encodeURIComponent(spaceId)}/plugins/${encodeURIComponent(pluginId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`remove plugin failed: ${res.status}`);
}

/** The group spaces the caller owns, each flagged with whether `pluginId` is applied there. */
export async function getPluginPlaces(pluginId: string): Promise<PluginPlace[]> {
  const res = await apiFetch(`/api/plugins/${encodeURIComponent(pluginId)}/places`);
  if (!res.ok) return [];
  const data = (await res.json()) as { places?: PluginPlace[] };
  return Array.isArray(data.places) ? data.places : [];
}

// ── plugin data sources (tasks / calendar) ───────────────────────────────────

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  assignee?: string;
  due?: string;
  labels?: string[];
  priority?: "low" | "normal" | "high";
  url?: string;
  /** Owned tasks (#34): the calendar (folder) the task lives in. */
  spaceId?: string;
  path?: string;
  calendarId?: string;
  editable?: boolean;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end?: string;
  allDay?: boolean;
  kind?: "milestone" | "release" | "issue" | "event";
  url?: string;
  tone?: string;
  /** Owned events (#34): calendar coordinates so the aggregator can group/color/toggle. */
  spaceId?: string;
  path?: string;
  calendarId?: string;
  color?: string;
  editable?: boolean;
}

/** A calendar: a shareable virtual folder of scheduling items (#34). */
export interface Calendar {
  id: string;
  spaceId: string;
  path: string;
  name: string;
  color?: string | null;
  role: "viewer" | "editor" | "owner";
}

/** What external sources are connected (e.g. GitHub), so views show live vs. sample. */
export interface Integrations {
  /** Source plugin ids available on the server. */
  sources: string[];
  /** The connected GitHub source id, or null if none resolves for the caller. */
  sourceId: string | null;
  /** The resolved repo (for display), or null. */
  repo: string | null;
  /** True when falling back to the server's demo default (not the caller's own). */
  usingDefault: boolean;
}

export async function getIntegrations(): Promise<Integrations> {
  const empty: Integrations = { sources: [], sourceId: null, repo: null, usingDefault: false };
  try {
    const res = await apiFetch("/api/integrations");
    if (!res.ok) return empty;
    return (await res.json()) as Integrations;
  } catch {
    return empty;
  }
}

// ── generic plugin settings (schema-driven) ───────────────────────────────────

/** A model the deployment's AI gateway exposes (Cloudflare Workers AI, Gemini, local). */
export interface AiModel {
  id: string;
  label: string;
  provider: string;
  vision?: boolean;
  /** One-line "what it's good for", shown as a tooltip in the model list. */
  description?: string;
}

/** Models available for plugins to use, or [] when the server has no AI provider. */
export async function listAiModels(): Promise<AiModel[]> {
  try {
    const res = await apiFetch("/api/ai/models");
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: AiModel[] };
    return Array.isArray(data.models) ? data.models : [];
  } catch {
    return [];
  }
}

/**
 * Run inference through the host's AI gateway (the same gateway server-side
 * processors use). The caller never holds a provider key. Throws with the
 * server's message on failure so the UI can show it.
 */
export async function aiGenerate(req: {
  messages: AiMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
}): Promise<string> {
  const res = await apiFetch("/api/ai/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? `generate failed: ${res.status}`);
  return data.text ?? "";
}

// ── AI-generated plugins (Plugin Studio) ──────────────────────────────────────

/** A plugin the caller authored at runtime: its manifest plus the ESM viewer source. */
export interface CustomPlugin {
  id: string;
  manifest: PluginManifest;
  source: string;
  createdAt: string;
  updatedAt: string;
}

/** The caller's generated plugins (empty when none or unavailable). */
export async function fetchCustomPlugins(): Promise<CustomPlugin[]> {
  try {
    const res = await apiFetch("/api/plugins/custom");
    if (!res.ok) return [];
    const data = (await res.json()) as { plugins?: CustomPlugin[] };
    return Array.isArray(data.plugins) ? data.plugins : [];
  } catch {
    return [];
  }
}

/** Persist + install a generated plugin. Throws with the server's message on rejection. */
export async function saveCustomPlugin(manifest: PluginManifest, source: string): Promise<void> {
  const res = await apiFetch("/api/plugins/custom", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest, source }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `save plugin failed: ${res.status}`);
}

/** Uninstall + delete a generated plugin. */
export async function deleteCustomPlugin(id: string): Promise<void> {
  const res = await apiFetch(`/api/plugins/custom/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete plugin failed: ${res.status}`);
}

/** One processor run over a file, from the aggregate processing feed. */
export interface ProcessingRun {
  fileId: string;
  fileName: string;
  spaceName: string;
  at: string;
  plugin: string;
  status: "ok" | "error";
  model?: string;
  labels?: string[];
  described?: boolean;
  note?: string;
}

/** Recent processor runs across the caller's spaces, newest first (a plugin's activity view). */
export async function listProcessing(plugin?: string, limit?: number): Promise<ProcessingRun[]> {
  const params = new URLSearchParams();
  if (plugin) params.set("plugin", plugin);
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  const res = await apiFetch(`/api/processing${qs ? `?${qs}` : ""}`);
  if (!res.ok) return [];
  return (await res.json()) as ProcessingRun[];
}

/** Fetch a source plugin's settings schema + current values (secrets redacted). */
export async function getPluginSettings(pluginId: string): Promise<PluginSettings | null> {
  const res = await apiFetch(`/api/plugins/${encodeURIComponent(pluginId)}/settings`);
  if (!res.ok) return null;
  return (await res.json()) as PluginSettings;
}

/**
 * Save a plugin's settings. Omit a key to leave it unchanged; an empty secret is
 * treated as "keep existing" server-side (so the user needn't re-enter the token).
 */
export async function savePluginSettings(pluginId: string, values: Record<string, string>): Promise<void> {
  const res = await apiFetch(`/api/plugins/${encodeURIComponent(pluginId)}/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) throw new Error(`save settings failed: ${res.status}`);
}

/** Tasks from the connected source. `source` is null when nothing is connected. */
export async function getTasks(): Promise<{ source: string | null; tasks: Task[] }> {
  const res = await apiFetch("/api/tasks");
  if (!res.ok) return { source: null, tasks: [] };
  return (await res.json()) as { source: string | null; tasks: Task[] };
}

/**
 * The aggregated calendar stream: the caller's owned events plus any connected
 * source's, with the caller's owned calendars for the aggregator's calendar list.
 * `source` is null when nothing contributed.
 */
export async function getCalendar(range?: { from: string; to: string }): Promise<{
  source: string | null;
  events: CalendarEvent[];
  calendars: Calendar[];
}> {
  const q = range ? `?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}` : "";
  const res = await apiFetch(`/api/calendar${q}`);
  if (!res.ok) return { source: null, events: [], calendars: [] };
  const data = (await res.json()) as { source: string | null; events: CalendarEvent[]; calendars?: Calendar[] };
  return { source: data.source, events: data.events, calendars: data.calendars ?? [] };
}

// ── owned scheduling: calendars / events / tasks (#34) ────────────────────────

/** The caller's owned calendars (= virtual folders). `space` scopes to one space. */
export async function listCalendars(space?: string): Promise<Calendar[]> {
  const q = space ? `?space=${encodeURIComponent(space)}` : "";
  const res = await apiFetch(`/api/calendars${q}`);
  if (!res.ok) return [];
  return ((await res.json()) as { calendars?: Calendar[] }).calendars ?? [];
}

/** Create a calendar (a colored virtual folder) in a space. */
export async function createCalendar(input: {
  name: string;
  space?: string;
  path?: string;
  color?: string | null;
}): Promise<Calendar> {
  const res = await apiFetch("/api/calendars", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json().catch(() => ({}))) as { created?: Calendar; error?: string };
  if (!res.ok || !data.created) throw new Error(data.error ?? `create calendar failed: ${res.status}`);
  return data.created;
}

/** Share a calendar (folder) with a person by email. */
export async function shareCalendar(input: {
  space: string;
  path: string;
  email: string;
  role?: "viewer" | "editor";
}): Promise<void> {
  const res = await apiFetch("/api/calendars/share", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`share calendar failed: ${res.status}`);
}

export interface CreateEventInput {
  title: string;
  space?: string;
  path?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  description?: string;
  location?: string;
  keywords?: string[];
}

/** Create an owned event in a calendar. Returns the stored event id. */
export async function createEvent(input: CreateEventInput): Promise<{ id: string }> {
  const res = await apiFetch("/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json().catch(() => ({}))) as { created?: { id: string }; error?: string };
  if (!res.ok || !data.created) throw new Error(data.error ?? `create event failed: ${res.status}`);
  return data.created;
}

export async function updateEvent(id: string, patch: Partial<CreateEventInput>): Promise<void> {
  const res = await apiFetch(`/api/events/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`update event failed: ${res.status}`);
}

export async function deleteEvent(id: string): Promise<void> {
  const res = await apiFetch(`/api/events/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete event failed: ${res.status}`);
}

export interface CreateTaskInput {
  title: string;
  space?: string;
  path?: string;
  status?: TaskStatus;
  progress?: number;
  start?: string;
  due?: string;
  priority?: "low" | "normal" | "high";
  keywords?: string[];
}

/** Create an owned task in a calendar. */
export async function createTask(input: CreateTaskInput): Promise<{ id: string }> {
  const res = await apiFetch("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json().catch(() => ({}))) as { created?: { id: string }; error?: string };
  if (!res.ok || !data.created) throw new Error(data.error ?? `create task failed: ${res.status}`);
  return data.created;
}

export async function updateTask(id: string, patch: Partial<CreateTaskInput>): Promise<void> {
  const res = await apiFetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`update task failed: ${res.status}`);
}

export async function deleteTask(id: string): Promise<void> {
  const res = await apiFetch(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete task failed: ${res.status}`);
}

export function loginUrl(returnTo: string): string {
  return `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export async function logout(): Promise<void> {
  await apiFetch("/api/auth/logout", { method: "POST" });
}
