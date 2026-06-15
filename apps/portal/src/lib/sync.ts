/**
 * Offline-mirror sync: keeps the browser's metadata mirror (IndexedDB, see
 * offline-cache.ts) up to date with the server by pulling a cursor-based delta from
 * `GET /api/changes`, and serves folder views from it. D1 stays the source of truth;
 * this is a scoped, read-only replica of the file metadata the caller can see.
 *
 * Correctness rests on polling — a pull on reconnect, on tab focus, and a slow
 * interval. The live SSE channel (connectLiveChannel) is only a latency optimization
 * layered on top: a nudge just triggers the same pull. Everything is best-effort and
 * falls back to the legacy listing cache when the mirror has nothing yet.
 */
import { folderView, normPath, type DeltaResponse, type MirrorFile, type MirrorStore } from "@canopy/mirror";
import { apiFetch, isBackendReachable, subscribeReachable } from "@/lib/connectivity";
import { idbMirrorStore } from "@/lib/offline-cache";

/**
 * The local persistence engine for the mirror, behind the {@link MirrorStore} adapter.
 * This is the one place the storage backend is chosen: swap `idbMirrorStore` for a
 * Drizzle + SQLite-WASM (OPFS) adapter — or any other `MirrorStore` — and nothing else
 * in this module (or the app) changes.
 */
const store: MirrorStore = idbMirrorStore;

/**
 * Whether the offline metadata mirror is active. **On by default** for every build
 * (including forks / the Deploy-to-Cloudflare button); set `VITE_SYNC_MIRROR=0` (or
 * "false") at build time to opt out. The server side (`/api/changes`, the seq bumps,
 * the SSE channel) is additive and harmless regardless of this flag — it only gates
 * whether the client reads/syncs through the mirror.
 */
export const MIRROR_ENABLED =
  import.meta.env.VITE_SYNC_MIRROR !== "0" && import.meta.env.VITE_SYNC_MIRROR !== "false";

/** Safety-net interval: re-pull while the tab is visible, in case a live bump was
 *  missed (SSE can drop silently). Navigation itself reads locally; it only kicks a
 *  throttled background refresh. */
const POLL_INTERVAL_MS = 45_000;
/** Don't fire a background pull from navigation more often than this — SSE/focus/
 *  interval already keep the mirror fresh, so per-click pulls would just be chatter. */
const NAV_PULL_THROTTLE_MS = 15_000;

export interface SyncStatus {
  syncing: boolean;
  /** Epoch ms of the last successful pull, or 0 if never. */
  lastSyncedAt: number;
  /** True when the last pull failed (offline / error). */
  error: boolean;
}

let status: SyncStatus = { syncing: false, lastSyncedAt: 0, error: false };
let mirrorVersion = 0; // bumps whenever applied changes mutate the mirror
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Subscribe to sync-status / mirror-version changes (for useSyncExternalStore). */
export function subscribeSync(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export function getSyncStatus(): SyncStatus {
  return status;
}
/** A monotonically increasing token that changes whenever the mirror's rows change. */
export function getMirrorVersion(): number {
  return mirrorVersion;
}

let pulling: Promise<void> | null = null;

/**
 * Pull every space's changes since the stored cursors and fold them into the mirror,
 * paging until the server reports no more. Deduped — concurrent callers share one
 * in-flight pull. Never throws; failures flip `status.error` and leave the mirror as-is.
 */
export function pull(): Promise<void> {
  if (!MIRROR_ENABLED) return Promise.resolve();
  if (pulling) return pulling;
  status = { ...status, syncing: true };
  emit();
  pulling = (async () => {
    let changed = false;
    try {
      let cursors = await store.readCursors();
      for (let guard = 0; guard < 10_000; guard++) {
        const res = await apiFetch(`/api/changes?since=${encodeURIComponent(JSON.stringify(cursors))}`);
        if (!res.ok) {
          // 401 (signed out) etc. — not an error worth flagging; just stop.
          status = { ...status, error: false };
          break;
        }
        const data = (await res.json()) as DeltaResponse;
        if (data.changes.length) {
          await store.applyChanges(data.changes);
          changed = true;
        }
        cursors = { ...cursors, ...data.cursor };
        await store.writeCursors(cursors);
        await store.writeScope(data.spaces);
        await pruneToScope(data.spaces.map((s) => s.id));
        cursors = await store.readCursors(); // re-sync local copy after any prune
        if (!data.hasMore) break;
      }
      status = { syncing: false, lastSyncedAt: Date.now(), error: false };
    } catch {
      status = { ...status, syncing: false, error: true };
    } finally {
      pulling = null;
      if (changed) mirrorVersion++;
      emit();
    }
  })();
  return pulling;
}

/** Force an immediate re-sync (the manual "Refresh" action). Resolves to the same
 *  deduped pull; a no-op resolved promise when the mirror is disabled. */
export function forceSync(): Promise<void> {
  return pull();
}

/** Drop the mirror rows + cursor for any space no longer in `keep` (access revoked),
 *  using the store's primitives — the orchestration lives here, not in the adapter. */
async function pruneToScope(keep: string[]): Promise<void> {
  const cursors = await store.readCursors();
  const keepSet = new Set(keep);
  const gone = Object.keys(cursors).filter((id) => !keepSet.has(id));
  if (!gone.length) return;
  for (const id of gone) {
    await store.dropSpace(id);
    delete cursors[id];
  }
  await store.writeCursors(cursors);
}

/**
 * Resolve the UI's space token to a real mirror space id (the server `tenant_id`).
 *  - "" / undefined → the personal drive (by kind, or the deterministic `personal:`
 *    prefix as a fallback if an older server's scope lacked `kind`).
 *  - "shared" → null (shared-with-me isn't mirrored; it stays a live fetch).
 *  - "connector:<plugin>" (the UI token) → the real connected-space id
 *    "connector:<plugin>:<sub>", looked up in the cached scope.
 *  - anything else → a real group-space id, passed through.
 */
async function resolveSpaceId(space: string | undefined): Promise<string | null> {
  if (space === "shared") return null;
  const scope = await store.readScope();
  if (!space) {
    return scope.find((s) => s.kind === "personal")?.id ?? scope.find((s) => s.id.startsWith("personal:"))?.id ?? null;
  }
  if (space.startsWith("connector:")) {
    return scope.find((s) => s.id === space || s.id.startsWith(`${space}:`))?.id ?? null;
  }
  return space;
}

/**
 * One folder's view, derived purely from the local mirror — the client half of "same
 * code both sides" (`folderView` also runs on the server's rows). **Reads are local,
 * not networked:** normal navigation makes no server call. The mirror is kept fresh out
 * of band — SSE pushes live changes, and a pull runs on (re)connect, focus, and a slow
 * interval. The server is only contacted here in two cases: a cold first load (nothing
 * synced yet), or opening a space we have no cursor for yet (e.g. one just shared with
 * us) — both bootstrap that space before rendering. Returns null when the mirror can't
 * serve it (disabled, or never synced and offline), so the caller falls back to the network.
 */
export async function mirrorFolder(
  dir: string,
  space: string | undefined,
): Promise<{ files: MirrorFile[]; folders: string[] } | null> {
  if (!MIRROR_ENABLED) return null;
  // Never block a read on the network — kick a throttled background refresh and read
  // locally. The initial bootstrap runs via startSync(); a space we have no cursor for
  // yet (fresh device, or a connected space mid-bootstrap) returns null so the caller
  // falls back to a one-off live fetch for that view while the mirror fills in.
  if (status.lastSyncedAt === 0 || Date.now() - status.lastSyncedAt > NAV_PULL_THROTTLE_MS) void pull();
  const spaceId = await resolveSpaceId(space);
  if (!spaceId) return null;
  const cursors = await store.readCursors();
  if (!(spaceId in cursors)) return null;
  return folderView(await store.readSpace(spaceId), dir);
}

/**
 * Every mirror file at or below a virtual folder path in a space — the file set a
 * recursive "available offline" folder pin expands to (see `reconcilePins` in lib/api.ts).
 * Reads purely from the local mirror; returns [] when the mirror is off or the space isn't
 * synced yet. `path === ""` means the whole space. `MirrorFile.path` is already normalized,
 * so a prefix match on the normalized pin path captures the folder and its whole subtree.
 */
export async function mirrorFilesUnder(space: string | undefined, path: string): Promise<MirrorFile[]> {
  if (!MIRROR_ENABLED) return [];
  const spaceId = await resolveSpaceId(space);
  if (!spaceId) return [];
  const rows = await store.readSpace(spaceId);
  const prefix = normPath(path);
  if (!prefix) return rows;
  return rows.filter((r) => r.path === prefix || r.path.startsWith(prefix + "/"));
}

// ── triggers (reconnect, focus, interval, live channel) ───────────────────────

let started = false;
const liveStreams = new Map<string, EventSource>();

/** Wire the mirror's refresh triggers once: initial pull, reconnect, tab focus, a
 *  slow visible-tab interval, and the live SSE channels. Idempotent; no-op when off. */
export function startSync(): void {
  if (!MIRROR_ENABLED || started || typeof window === "undefined") return;
  started = true;

  void pull().then(connectLiveChannel);

  subscribeReachable(() => {
    if (isBackendReachable()) {
      void pull().then(connectLiveChannel); // reconnect the streams too
    }
  });

  window.setInterval(() => {
    if (document.visibilityState === "visible" && isBackendReachable()) void pull().then(connectLiveChannel);
  }, POLL_INTERVAL_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void pull().then(connectLiveChannel);
  });
}

/**
 * Open one SSE stream per space in scope, so another session's change nudges us to
 * pull promptly. The `SpaceChannel` Durable Object is keyed per space, so we subscribe
 * per space; each payload carries no file data — only "this space advanced, go pull" —
 * so the ACL surface stays in the delta endpoint. Connected spaces (connector:*) are
 * skipped (the periodic poll covers them). Best-effort; EventSource auto-reconnects and
 * polling is the correctness floor. Reconciles open streams against the current scope:
 * opens new spaces, closes ones we've lost access to or that hard-closed.
 */
export async function connectLiveChannel(): Promise<void> {
  if (!MIRROR_ENABLED || typeof EventSource === "undefined") return;
  const scope = (await store.readScope()).filter((s) => !s.id.startsWith("connector:"));
  const want = new Set(scope.map((s) => s.id));
  for (const [id, es] of liveStreams) {
    if (!want.has(id) || es.readyState === EventSource.CLOSED) {
      es.close();
      liveStreams.delete(id);
    }
  }
  for (const s of scope) {
    if (liveStreams.has(s.id)) continue;
    try {
      const es = new EventSource(`/api/changes/stream?space=${encodeURIComponent(s.id)}`);
      // Catch up on every (re)connect — a dropped-then-reconnected stream doesn't replay
      // the bumps it missed, so pull once when it opens. Then bumps keep it live.
      es.onopen = () => void pull();
      es.addEventListener("bump", () => void pull());
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) liveStreams.delete(s.id);
      };
      liveStreams.set(s.id, es);
    } catch {
      // EventSource construction failed — polling still covers this space.
    }
  }
}
