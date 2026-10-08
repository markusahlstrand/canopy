/** Device-local, opt-in file bytes. The metadata mirror still owns default offline browsing. */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { readOfflineBytes } from './offline-bytes';

const DB_NAME = 'canopy.scope-content';
const MAX_FILE_BYTES = 20_000_000;
const MAX_SCOPE_BYTES = 250_000_000;

export class OfflineContentHttpError extends Error {
  constructor(readonly status: number, name: string) {
    super(`Could not save ${name} offline (${status}).`);
  }
}

export interface OfflineContentKey {
  principal: string;
  space: string;
  fileId: string;
  versionId: string;
}

export interface CachedVersion extends OfflineContentKey {
  name: string;
  mime: string;
  bytes: ArrayBuffer;
  savedAt: number;
  /** Folder ids whose local pins require this version. */
  pinnedBy: string[];
}

export interface FolderPin {
  principal: string;
  space: string;
  folderId: string;
  name: string;
  status: 'syncing' | 'ready' | 'partial' | 'error';
  updatedAt: number;
}

interface ContentDb extends DBSchema {
  versions: {
    key: [string, string, string, string];
    value: CachedVersion;
    indexes: { 'by-space': [string, string] };
  };
  pins: {
    key: [string, string, string];
    value: FolderPin;
    indexes: { 'by-space': [string, string] };
  };
  routes: { key: [string, string]; value: { principal: string; route: string; space: string } };
  session: { key: string; value: { key: string; epoch: number; revoked: boolean; principal?: string } };
}

let dbPromise: Promise<IDBPDatabase<ContentDb>> | undefined;
const db = () => (dbPromise ??= openDB<ContentDb>(DB_NAME, 2, {
  upgrade(database, oldVersion) {
    if (oldVersion < 1) {
      const versions = database.createObjectStore('versions', { keyPath: ['principal', 'space', 'fileId', 'versionId'] });
      versions.createIndex('by-space', ['principal', 'space']);
      const pins = database.createObjectStore('pins', { keyPath: ['principal', 'space', 'folderId'] });
      pins.createIndex('by-space', ['principal', 'space']);
      database.createObjectStore('session', { keyPath: 'key' });
    }
    if (oldVersion < 2) database.createObjectStore('routes', { keyPath: ['principal', 'route'] });
  },
}).catch((error: unknown) => { dbPromise = undefined; throw error; }));

const VERSION_KEY = (key: OfflineContentKey): [string, string, string, string] =>
  [key.principal, key.space, key.fileId, key.versionId];
const PIN_KEY = (pin: Pick<FolderPin, 'principal' | 'space' | 'folderId'>): [string, string, string] =>
  [pin.principal, pin.space, pin.folderId];
const SESSION = 'current';

async function sessionEpoch(): Promise<number> {
  const session = await (await db()).get('session', SESSION);
  if (!session || session.revoked) throw new Error('The offline session ended. Sign in again.');
  return session.epoch;
}

/** Capture the login generation before an asynchronous folder walk begins. */
export const offlineSessionEpoch = sessionEpoch;

/** A successful online sign-in reopens the cache after a previous logout. */
export async function resumeOfflineContent(principal?: string): Promise<void> {
  const database = await db();
  const tx = database.transaction(['versions', 'pins', 'routes', 'session'], 'readwrite');
  const session = tx.objectStore('session');
  const previous = await session.get(SESSION);
  if (principal && previous?.principal && previous.principal !== principal) {
    await tx.objectStore('versions').clear();
    await tx.objectStore('pins').clear();
    await tx.objectStore('routes').clear();
  }
  await session.put({ key: SESSION, epoch: (previous?.epoch ?? 0) + 1, revoked: false, principal });
  await tx.done;
}

/** Sign-out and online 401 remove every user's bytes and pins at this origin. */
export async function clearOfflineContent(): Promise<void> {
  const database = await db();
  const tx = database.transaction(['versions', 'pins', 'routes', 'session'], 'readwrite');
  const session = tx.objectStore('session');
  const previous = await session.get(SESSION);
  await tx.objectStore('versions').clear();
  await tx.objectStore('pins').clear();
  await tx.objectStore('routes').clear();
  await session.put({ key: SESSION, epoch: (previous?.epoch ?? 0) + 1, revoked: true });
  await tx.done;
}

/** The default hostname has no ?site slug, so remember which scope it resolved to. */
export async function rememberOfflineSpace(principal: string, route: string, space: string): Promise<void> {
  const epoch = await sessionEpoch();
  const tx = (await db()).transaction(['routes', 'session'], 'readwrite');
  const session = await tx.objectStore('session').get(SESSION);
  if (!session || session.revoked || session.epoch !== epoch) {
    tx.abort(); await tx.done.catch(() => {});
    throw new Error('The offline session ended.');
  }
  await tx.objectStore('routes').put({ principal, route, space });
  await tx.done;
}

/** Resolve a remembered hostname route for this signed-in principal. */
export async function offlineSpace(principal: string, route: string): Promise<string | null> {
  const tx = (await db()).transaction(['routes', 'session'], 'readonly');
  const session = await tx.objectStore('session').get(SESSION);
  const row = session && !session.revoked ? await tx.objectStore('routes').get([principal, route]) : null;
  await tx.done;
  return row?.space ?? null;
}

/** List device pins only while the offline session is active. */
export async function listOfflinePins(principal: string, space: string): Promise<FolderPin[]> {
  const tx = (await db()).transaction(['pins', 'session'], 'readonly');
  const session = await tx.objectStore('session').get(SESSION);
  const pins = session && !session.revoked
    ? await tx.objectStore('pins').index('by-space').getAll([principal, space]) : [];
  await tx.done;
  return pins;
}

/** Create or retry a folder pin within the current login generation. */
export async function setOfflinePin(pin: FolderPin): Promise<void> {
  const epoch = await sessionEpoch();
  const database = await db();
  const tx = database.transaction(['pins', 'session'], 'readwrite');
  const session = await tx.objectStore('session').get(SESSION);
  if (session?.revoked || (session?.epoch ?? 0) !== epoch) {
    tx.abort(); await tx.done.catch(() => {});
    throw new Error('The offline session ended.');
  }
  await tx.objectStore('pins').put(pin);
  await tx.done;
}

/** A background walk may update an existing pin but may never recreate a removed one. */
export async function updateOfflinePinStatus(pin: FolderPin, status: FolderPin['status'], expectedEpoch?: number): Promise<boolean> {
  const epoch = expectedEpoch ?? await sessionEpoch();
  const tx = (await db()).transaction(['pins', 'session'], 'readwrite');
  const session = await tx.objectStore('session').get(SESSION);
  const pins = tx.objectStore('pins');
  const current = await pins.get(PIN_KEY(pin));
  if (!session || session.revoked || session.epoch !== epoch) {
    tx.abort(); await tx.done.catch(() => {});
    throw new Error('The offline session ended.');
  }
  if (current) await pins.put({ ...current, status, updatedAt: Date.now() });
  await tx.done;
  return !!current;
}

/** Unpin a folder and drop versions no other pinned folder needs. */
export async function removeOfflinePin(principal: string, space: string, folderId: string, expectedEpoch?: number): Promise<void> {
  const epoch = expectedEpoch ?? await sessionEpoch();
  const database = await db();
  const tx = database.transaction(['pins', 'versions', 'session'], 'readwrite');
  const session = await tx.objectStore('session').get(SESSION);
  if (!session || session.revoked || session.epoch !== epoch) {
    tx.abort(); await tx.done.catch(() => {});
    throw new Error('The offline session ended.');
  }
  await tx.objectStore('pins').delete(PIN_KEY({ principal, space, folderId }));
  const versions = tx.objectStore('versions');
  let cursor = await versions.index('by-space').openCursor([principal, space]);
  while (cursor) {
    const pinnedBy = cursor.value.pinnedBy.filter(id => id !== folderId);
    if (!pinnedBy.length) await cursor.delete();
    else if (pinnedBy.length !== cursor.value.pinnedBy.length) await cursor.update({ ...cursor.value, pinnedBy });
    cursor = await cursor.continue();
  }
  await tx.done;
}

/** Read a saved version only while the offline session is active. */
export async function getOfflineVersion(key: OfflineContentKey): Promise<CachedVersion | null> {
  const tx = (await db()).transaction(['versions', 'session'], 'readonly');
  const session = await tx.objectStore('session').get(SESSION);
  const version = session && !session.revoked
    ? await tx.objectStore('versions').get(VERSION_KEY(key)) : null;
  await tx.done;
  return version ?? null;
}

/** Distinguish an incomplete folder copy with saved bytes from an empty failed pin. */
export async function hasOfflinePinBytes(principal: string, space: string, folderId: string): Promise<boolean> {
  const tx = (await db()).transaction(['versions', 'session'], 'readonly');
  const session = await tx.objectStore('session').get(SESSION);
  if (!session || session.revoked) { await tx.done; return false; }
  let cursor = await tx.objectStore('versions').index('by-space').openCursor([principal, space]);
  while (cursor) {
    if (cursor.value.pinnedBy.includes(folderId)) { await tx.done; return true; }
    cursor = await cursor.continue();
  }
  await tx.done;
  return false;
}

/** Prefer the mirrored current version, then use the newest saved version if metadata lags. */
export async function getOfflineFileVersion(
  principal: string, space: string, fileId: string, preferredVersionId: string | null,
): Promise<CachedVersion | null> {
  const tx = (await db()).transaction(['versions', 'session'], 'readonly');
  const session = await tx.objectStore('session').get(SESSION);
  if (!session || session.revoked) { await tx.done; return null; }
  const versions = tx.objectStore('versions');
  const preferred = preferredVersionId
    ? await versions.get([principal, space, fileId, preferredVersionId]) : null;
  if (preferred) { await tx.done; return preferred; }
  const saved = await versions.getAll(IDBKeyRange.bound(
    [principal, space, fileId, ''], [principal, space, fileId, '\uffff'],
  ));
  await tx.done;
  return saved.reduce<CachedVersion | null>((latest, row) => !latest || row.savedAt >= latest.savedAt ? row : latest, null);
}

/** Reuse an unchanged version for another pin without a second byte download. */
export async function retainOfflineVersion(key: OfflineContentKey, folderId: string, expectedEpoch?: number, metadata?: Pick<CachedVersion, 'name'>): Promise<boolean> {
  const epoch = expectedEpoch ?? await sessionEpoch();
  const tx = (await db()).transaction(['versions', 'pins', 'session'], 'readwrite');
  const session = await tx.objectStore('session').get(SESSION);
  const pin = await tx.objectStore('pins').get(PIN_KEY({ ...key, folderId }));
  const versions = tx.objectStore('versions');
  const existing = await versions.get(VERSION_KEY(key));
  if (!session || session.revoked || session.epoch !== epoch || !pin) {
    tx.abort(); await tx.done.catch(() => {});
    throw new Error('The offline session or folder pin ended.');
  }
  if (existing && (!existing.pinnedBy.includes(folderId) || (metadata && metadata.name !== existing.name))) {
    await versions.put({ ...existing, ...metadata, pinnedBy: [...new Set([...existing.pinnedBy, folderId])] });
  }
  await tx.done;
  return !!existing;
}

/** Remove versions that a completed folder walk no longer needs. Never prune after a failed walk. */
export async function pruneOfflinePin(principal: string, space: string, folderId: string, current: Set<string>, expectedEpoch?: number): Promise<void> {
  const epoch = expectedEpoch ?? await sessionEpoch();
  const tx = (await db()).transaction(['versions', 'session'], 'readwrite');
  const session = await tx.objectStore('session').get(SESSION);
  if (!session || session.revoked || session.epoch !== epoch) {
    tx.abort(); await tx.done.catch(() => {});
    throw new Error('The offline session ended.');
  }
  let cursor = await tx.objectStore('versions').index('by-space').openCursor([principal, space]);
  while (cursor) {
    const row = cursor.value;
    if (row.pinnedBy.includes(folderId) && !current.has(`${row.fileId}\n${row.versionId}`)) {
      const pinnedBy = row.pinnedBy.filter(id => id !== folderId);
      if (pinnedBy.length) await cursor.update({ ...row, pinnedBy });
      else await cursor.delete();
    }
    cursor = await cursor.continue();
  }
  await tx.done;
}

/** Download from an already-authorized version URL. A logout during fetch cannot repopulate the cache. */
export async function cacheOfflineVersion(
  key: OfflineContentKey & { folderId: string; name: string; mime: string; url: string },
  fetcher: typeof fetch = fetch,
  expectedEpoch?: number,
): Promise<CachedVersion> {
  const epoch = expectedEpoch ?? await sessionEpoch();
  const response = await fetcher(key.url, { credentials: 'same-origin' });
  if (!response.ok) throw new OfflineContentHttpError(response.status, key.name);
  const bytes = await readOfflineBytes(response, MAX_FILE_BYTES, `${key.name} is larger than the 20 MB offline file limit.`);
  const database = await db();
  const tx = database.transaction(['versions', 'pins', 'session'], 'readwrite');
  const session = await tx.objectStore('session').get(SESSION);
  if (session?.revoked || (session?.epoch ?? 0) !== epoch) {
    tx.abort(); await tx.done.catch(() => {});
    throw new Error('The offline session ended.');
  }
  if (!await tx.objectStore('pins').get(PIN_KEY(key))) {
    tx.abort(); await tx.done.catch(() => {});
    throw new Error('This folder is no longer marked for offline access.');
  }
  const versions = tx.objectStore('versions');
  const existing = await versions.get(VERSION_KEY(key));
  const pinnedBy = [...new Set([...(existing?.pinnedBy ?? []), key.folderId])];
  let size = 0;
  let cursor = await versions.index('by-space').openCursor([key.principal, key.space]);
  while (cursor) {
    size += cursor.value.bytes.byteLength;
    cursor = await cursor.continue();
  }
  size += bytes.byteLength - (existing?.bytes.byteLength ?? 0);
  if (size > MAX_SCOPE_BYTES) {
    tx.abort(); await tx.done.catch(() => {});
    throw new Error('This device has reached the 250 MB offline limit for this space.');
  }
  const row: CachedVersion = {
    principal: key.principal, space: key.space, fileId: key.fileId, versionId: key.versionId,
    name: key.name, mime: key.mime, bytes, savedAt: Date.now(), pinnedBy,
  };
  try {
    await versions.put(row);
    await tx.done;
  } catch (error) {
    // A failed request also rejects the transaction. Consume both failures before
    // translating the request error into the message shown by the folder sync.
    await tx.done.catch(() => {});
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      throw new Error('This browser is out of storage space for offline files. Free device space or remove an offline folder, then retry.');
    }
    throw error;
  }
  return row;
}
