/**
 * The browser's metadata mirror. The source of truth is the scope event spine;
 * IndexedDB only remembers its last applied event id and the current rows the
 * feed hydrated. File bytes are never stored here.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { changes, type DriveChange, type DriveChanges, type DriveFile, type DriveFolder } from './api';
import { clearOfflineContent, resumeOfflineContent } from './offline-content';

interface SavedFile extends DriveFile { principal: string }
interface SavedFolder extends DriveFolder { principal: string }
interface Progress { principal: string; cursor: string | null; ready: boolean; epoch?: number; revoked?: boolean; offlinePrincipal?: string }

interface MirrorDb extends DBSchema {
  files: {
    key: [string, string]; value: SavedFile;
    indexes: { 'by-folder': [string, string] };
  };
  folders: {
    key: [string, string]; value: SavedFolder;
    indexes: { 'by-parent': [string, string] };
  };
  progress: { key: string; value: Progress };
}

let dbPromise: Promise<IDBPDatabase<MirrorDb>> | undefined;
const SESSION_KEY = '__mirror_session__';
const IDENTITY_PREFIX = '__offline_identity__:';
const CHANNEL = 'canopy.scope-mirror.session';
let blocked = false;
let channel: BroadcastChannel | undefined;
const logoutListeners = new Set<() => void>();
function sessionChannel(): BroadcastChannel | undefined {
  if (typeof BroadcastChannel === 'undefined') return undefined;
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = () => {
      void clearMirror(false).catch(() => {});
      for (const listener of logoutListeners) listener();
    };
  }
  return channel;
}

/** A second tab's logout must hide an already-open offline view too. */
export function onMirrorLogout(listener: () => void): () => void {
  sessionChannel();
  logoutListeners.add(listener);
  return () => logoutListeners.delete(listener);
}
const db = () => (dbPromise ??= openDB<MirrorDb>('canopy.scope-mirror', 1, {
  upgrade(database) {
    const files = database.createObjectStore('files', { keyPath: ['principal', 'id'] });
    files.createIndex('by-folder', ['principal', 'folder_id']);
    const folders = database.createObjectStore('folders', { keyPath: ['principal', 'id'] });
    folders.createIndex('by-parent', ['principal', 'parent_id']);
    database.createObjectStore('progress', { keyPath: 'principal' });
  },
}).catch((error: unknown) => {
  dbPromise = undefined;
  throw error;
}));

export interface MirrorStore {
  progress(principal: string): Promise<Progress | undefined>;
  apply(principal: string, page: DriveChanges, expectedCursor?: string | null, epoch?: number): Promise<void>;
  folder(principal: string, folderId: string): Promise<{ files: DriveFile[]; folders: DriveFolder[] } | null>;
}

class CursorAdvanced extends Error {}
class SessionEnded extends Error {}

async function applyIndexed(
  principal: string,
  page: DriveChanges,
  expectedCursor: string | null,
  epoch: number,
  stillCurrent: () => boolean = () => true,
): Promise<void> {
  const database = await db();
  // Check AFTER opening the database, immediately before starting a transaction.
  // Logout may have cleared this principal while an old openDB awaited.
  if (!stillCurrent() || blocked) throw new SessionEnded('the mirror session ended');
  // Rows and cursor commit together. A browser crash cannot remember an event id
  // whose corresponding metadata was never written.
  const tx = database.transaction(['files', 'folders', 'progress'], 'readwrite');
  const progress = tx.objectStore('progress');
  const session = await progress.get(SESSION_KEY);
  const previous = await progress.get(principal);
  if (!stillCurrent() || blocked || session?.revoked || (session?.epoch ?? 0) !== epoch) {
    tx.abort();
    await tx.done.catch(() => {});
    throw new SessionEnded('the mirror session ended');
  }
  if ((previous?.cursor ?? null) !== expectedCursor) {
    tx.abort();
    await tx.done.catch(() => {});
    throw new CursorAdvanced('another tab advanced the mirror cursor');
  }
  try {
    for (const change of page.changes) {
      if (change.entityType === 'file') {
        if (change.file) await tx.objectStore('files').put({ ...change.file, principal });
        else await tx.objectStore('files').delete([principal, change.entityId]);
      } else {
        if (change.folder) await tx.objectStore('folders').put({ ...change.folder, principal });
        else await tx.objectStore('folders').delete([principal, change.entityId]);
      }
    }
    await progress.put({
      principal, cursor: page.cursor, ready: previous?.ready || !page.hasMore,
    });
    await tx.done;
  } catch (error) {
    try { tx.abort(); } catch { /* An IndexedDB request may already have aborted it. */ }
    await tx.done.catch(() => {});
    throw error;
  }
}

export const indexedMirror: MirrorStore = {
  async progress(principal) {
    const database = await db();
    const session = await database.get('progress', SESSION_KEY);
    if (session?.revoked || blocked) throw new SessionEnded('the mirror session ended');
    const progress = await database.get('progress', principal);
    return { principal, cursor: progress?.cursor ?? null, ready: progress?.ready ?? false, epoch: session?.epoch ?? 0 };
  },

  async apply(principal, page, expectedCursor, epoch) {
    await applyIndexed(principal, page, expectedCursor ?? null, epoch ?? 0);
  },

  async folder(principal, folderId) {
    const database = await db();
    const progress = await database.get('progress', principal);
    if (!progress?.ready) return null;
    const [files, folders] = await Promise.all([
      database.getAllFromIndex('files', 'by-folder', [principal, folderId]),
      database.getAllFromIndex('folders', 'by-parent', [principal, folderId]),
    ]);
    return {
      files: files.map(({ principal: _principal, ...file }) => file),
      folders: folders.map(({ principal: _principal, ...folder }) => folder),
    };
  },
};

/** Remember only the principal, scoped to the routed hostname and selected site.
 * The mirror rows remain keyed by principal and are shown only after an initial sync
 * completed. Logout clears this pointer with the rows in one transaction. */
export async function rememberOfflineIdentity(siteKey: string, principal: string): Promise<void> {
  const database = await db();
  const tx = database.transaction('progress', 'readwrite');
  const session = await tx.store.get(SESSION_KEY);
  if (blocked || session?.revoked) {
    tx.abort();
    await tx.done.catch(() => {});
    throw new SessionEnded('the mirror session ended');
  }
  await tx.store.put({ principal: `${IDENTITY_PREFIX}${siteKey}`, cursor: null, ready: false, offlinePrincipal: principal });
  await tx.done;
}

/** A network failure may use saved names only for the last authenticated site and
 * only after its first event-feed pass finished. An online 401 never calls this. */
export async function offlineIdentity(siteKey: string): Promise<string | null> {
  sessionChannel();
  if (blocked) return null;
  const database = await db();
  const tx = database.transaction('progress', 'readonly');
  const session = await tx.store.get(SESSION_KEY);
  const marker = await tx.store.get(`${IDENTITY_PREFIX}${siteKey}`);
  const progress = marker?.offlinePrincipal ? await tx.store.get(marker.offlinePrincipal) : undefined;
  await tx.done;
  if (blocked || session?.revoked || !progress?.ready) return null;
  return marker?.offlinePrincipal ?? null;
}

/** Consume every available page. The supplied store makes the cursor rule testable
 * without depending on a browser's IndexedDB implementation. */
export async function syncFromSpine(
  principal: string,
  store: MirrorStore,
  readPage: (after: string | null) => Promise<DriveChanges>,
): Promise<void> {
  let progress = await store.progress(principal);
  let cursor = progress?.cursor ?? null;
  for (;;) {
    const page = await readPage(cursor);
    if (page.hasMore && page.cursor === cursor) {
      throw new Error('the changes feed did not advance its cursor');
    }
    try {
      await store.apply(principal, page, cursor, progress?.epoch ?? 0);
    } catch (error) {
      if (!(error instanceof CursorAdvanced)) throw error;
      progress = await store.progress(principal);
      cursor = progress?.cursor ?? null;
      continue;
    }
    if (!page.hasMore) return;
    cursor = page.cursor;
  }
}

/** One sync per principal at a time: refreshes can overlap after a write or a
 * folder navigation, but they must not race their cursor transactions. */
const inFlight = new Map<string, Promise<void>>();
const generations = new Map<string, number>();

export function syncMirror(principal: string): Promise<void> {
  sessionChannel();
  if (blocked) return Promise.reject(new SessionEnded('the mirror session ended'));
  const current = inFlight.get(principal);
  if (current) return current;
  const generation = generations.get(principal) ?? 0;
  const store: MirrorStore = {
    ...indexedMirror,
    apply: (who, page, expectedCursor, epoch) => applyIndexed(
      who, page, expectedCursor ?? null, epoch ?? 0,
      () => (generations.get(principal) ?? 0) === generation,
    ),
  };
  const run = syncFromSpine(principal, store, changes).finally(() => {
    if (inFlight.get(principal) === run) inFlight.delete(principal);
  });
  inFlight.set(principal, run);
  return run;
}

/** A logout clears every space mirrored by this origin, including spaces other
 * than the one currently selected. Any in-flight sync is invalidated first. */
export async function clearMirror(broadcast = true): Promise<void> {
  blocked = true;
  if (broadcast) sessionChannel()?.postMessage('logout');
  for (const principal of inFlight.keys()) {
    generations.set(principal, (generations.get(principal) ?? 0) + 1);
  }
  inFlight.clear();
  // A blocked content store must not prevent the metadata identity from being revoked.
  await clearOfflineContent().catch(() => {});
  const database = await db();
  const tx = database.transaction(['files', 'folders', 'progress'], 'readwrite');
  const progress = tx.objectStore('progress');
  const session = await progress.get(SESSION_KEY);
  await Promise.all([
    tx.objectStore('files').clear(),
    tx.objectStore('folders').clear(),
    progress.clear(),
  ]);
  await progress.put({ principal: SESSION_KEY, cursor: null, ready: false,
    epoch: (session?.epoch ?? 0) + 1, revoked: true });
  await tx.done;
}

/** A fresh authenticated page may reopen the cache after logout invalidated it. */
export async function resumeMirror(principal?: string): Promise<void> {
  if (blocked) throw new SessionEnded('the mirror session ended');
  const database = await db();
  const tx = database.transaction(['files', 'folders', 'progress'], 'readwrite');
  const progress = tx.objectStore('progress');
  const session = await progress.get(SESSION_KEY);
  if (blocked) {
    tx.abort();
    await tx.done.catch(() => {});
    throw new SessionEnded('the mirror session ended');
  }
  if (principal && session?.offlinePrincipal && session.offlinePrincipal !== principal) {
    await tx.objectStore('files').clear();
    await tx.objectStore('folders').clear();
    await progress.clear();
  }
  await progress.put({ principal: SESSION_KEY, cursor: null, ready: false,
    epoch: (session?.epoch ?? 0) + 1, revoked: false, offlinePrincipal: principal });
  await tx.done;
  await resumeOfflineContent(principal).catch(() => {});
  blocked = false;
  sessionChannel();
}

export type { DriveChange };
