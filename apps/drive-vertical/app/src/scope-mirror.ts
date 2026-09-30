/**
 * The browser's metadata mirror. The source of truth is the scope event spine;
 * IndexedDB only remembers its last applied event id and the current rows the
 * feed hydrated. File bytes are never stored here.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { changes, type DriveChange, type DriveChanges, type DriveFile, type DriveFolder } from './api';

interface SavedFile extends DriveFile { principal: string }
interface SavedFolder extends DriveFolder { principal: string }
interface Progress { principal: string; cursor: string | null; ready: boolean }

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
  apply(principal: string, page: DriveChanges): Promise<void>;
  folder(principal: string, folderId: string): Promise<{ files: DriveFile[]; folders: DriveFolder[] } | null>;
}

async function applyIndexed(
  principal: string,
  page: DriveChanges,
  stillCurrent: () => boolean = () => true,
): Promise<void> {
  const database = await db();
  // Check AFTER opening the database, immediately before starting a transaction.
  // Logout may have cleared this principal while an old openDB awaited.
  if (!stillCurrent()) throw new Error('the mirror session ended');
  // Rows and cursor commit together. A browser crash cannot remember an event id
  // whose corresponding metadata was never written.
  const tx = database.transaction(['files', 'folders', 'progress'], 'readwrite');
  for (const change of page.changes) {
    if (change.entityType === 'file') {
      if (change.file) tx.objectStore('files').put({ ...change.file, principal });
      else tx.objectStore('files').delete([principal, change.entityId]);
    } else {
      if (change.folder) tx.objectStore('folders').put({ ...change.folder, principal });
      else tx.objectStore('folders').delete([principal, change.entityId]);
    }
  }
  const previous = await tx.objectStore('progress').get(principal);
  tx.objectStore('progress').put({
    principal, cursor: page.cursor, ready: previous?.ready || !page.hasMore,
  });
  await tx.done;
}

export const indexedMirror: MirrorStore = {
  async progress(principal) {
    return (await db()).get('progress', principal);
  },

  async apply(principal, page) {
    await applyIndexed(principal, page);
  },

  async folder(principal, folderId) {
    const database = await db();
    const progress = await database.get('progress', principal);
    if (!progress?.ready) return null;
    const [files, folders] = await Promise.all([
      database.getAllFromIndex('files', 'by-folder', [principal, folderId]),
      database.getAllFromIndex('folders', 'by-parent', [principal, folderId]),
    ]);
    return { files, folders };
  },
};

/** Consume every available page. The supplied store makes the cursor rule testable
 * without depending on a browser's IndexedDB implementation. */
export async function syncFromSpine(
  principal: string,
  store: MirrorStore,
  readPage: (after: string | null) => Promise<DriveChanges>,
): Promise<void> {
  let cursor = (await store.progress(principal))?.cursor ?? null;
  for (;;) {
    const page = await readPage(cursor);
    if (page.hasMore && page.cursor === cursor) {
      throw new Error('the changes feed did not advance its cursor');
    }
    await store.apply(principal, page);
    if (!page.hasMore) return;
    cursor = page.cursor;
  }
}

/** One sync per principal at a time: refreshes can overlap after a write or a
 * folder navigation, but they must not race their cursor transactions. */
const inFlight = new Map<string, Promise<void>>();
const generations = new Map<string, number>();

export function syncMirror(principal: string): Promise<void> {
  const current = inFlight.get(principal);
  if (current) return current;
  const generation = generations.get(principal) ?? 0;
  const store: MirrorStore = {
    ...indexedMirror,
    apply: (who, page) => applyIndexed(
      who, page, () => (generations.get(principal) ?? 0) === generation,
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
export async function clearMirror(): Promise<void> {
  for (const principal of inFlight.keys()) {
    generations.set(principal, (generations.get(principal) ?? 0) + 1);
  }
  inFlight.clear();
  const database = await db();
  const tx = database.transaction(['files', 'folders', 'progress'], 'readwrite');
  tx.objectStore('files').clear();
  tx.objectStore('folders').clear();
  tx.objectStore('progress').clear();
  await tx.done;
}

export type { DriveChange };
