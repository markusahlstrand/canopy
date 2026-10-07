import {
  ApiError, fileVersionsPage, listFolderPage, listFoldersPage, versionContentUrl,
  type DriveFile, type DriveFolder, type FileVersion, type ListingPage,
} from './api';
import {
  cacheOfflineVersion, getOfflineVersion, listOfflinePins, OfflineContentHttpError, pruneOfflinePin, removeOfflinePin,
  retainOfflineVersion, updateOfflinePinStatus, type FolderPin,
} from './offline-content';
import { clearMirror } from './scope-mirror';

export interface OfflineFolderSource {
  folders(folderId: string, next: string | null, space: string): Promise<ListingPage<DriveFolder>>;
  files(folderId: string, next: string | null, space: string): Promise<ListingPage<DriveFile>>;
  versions(fileId: string, next: string | null, space: string): Promise<{ versions: FileVersion[]; next: string | null }>;
  contentUrl(fileId: string, versionId: string, space: string): string;
}

export const liveOfflineFolderSource: OfflineFolderSource = {
  folders: (id, next, space) => listFoldersPage(id, next, space),
  files: (id, next, space) => listFolderPage(id, next, space),
  versions: (id, next, space) => fileVersionsPage(id, next, space),
  contentUrl: (id, version, space) => versionContentUrl(id, version, space),
};

async function currentVersion(file: DriveFile, space: string, source: OfflineFolderSource): Promise<FileVersion | null> {
  if (!file.current_version_id) return null;
  let next: string | null = null;
  do {
    const page = await source.versions(file.id, next, space);
    const version = page.versions.find(row => row.id === file.current_version_id);
    if (version) return version;
    next = page.next;
  } while (next);
  throw new Error(`Could not find the current version of ${file.name}.`);
}

export interface FolderSyncProgress { folders: number; files: number }

/** A complete authorized walk is required before a pin may say Ready or prune old bytes. */
export async function syncOfflineFolder(
  pin: FolderPin,
  source: OfflineFolderSource = liveOfflineFolderSource,
  onProgress: (progress: FolderSyncProgress) => void = () => {},
  shouldContinue: () => boolean = () => true,
): Promise<FolderSyncProgress> {
  if (!await updateOfflinePinStatus(pin, 'syncing')) throw new Error('This folder is no longer marked for offline access.');
  const progress: FolderSyncProgress = { folders: 0, files: 0 };
  const current = new Set<string>();
  const queue = [pin.folderId];
  const seenFolders = new Set<string>();
  try {
    while (queue.length) {
      if (!shouldContinue()) throw new Error('Offline download was stopped.');
      const folderId = queue.shift()!;
      if (seenFolders.has(folderId)) continue;
      seenFolders.add(folderId);
      if (seenFolders.size > 10_000) throw new Error('This folder is too large to save offline.');
      let next: string | null = null;
      do {
        const page = await source.folders(folderId, next, pin.space);
        for (const child of page.entries) queue.push(child.id);
        next = page.next;
      } while (next);
      progress.folders++;
      onProgress({ ...progress });
      next = null;
      do {
        const page = await source.files(folderId, next, pin.space);
        for (const file of page.entries) {
          if (!shouldContinue()) throw new Error('Offline download was stopped.');
          const version = await currentVersion(file, pin.space, source);
          if (!version) continue;
          const key = { principal: pin.principal, space: pin.space, fileId: file.id, versionId: version.id };
          const cached = await getOfflineVersion(key);
          if (!cached || !await retainOfflineVersion(key, pin.folderId)) {
            await cacheOfflineVersion({ ...key, folderId: pin.folderId, name: file.name, mime: version.mime,
              url: source.contentUrl(file.id, version.id, pin.space) });
          }
          current.add(`${file.id}\n${version.id}`);
          progress.files++;
          onProgress({ ...progress });
        }
        next = page.next;
      } while (next);
    }
    if (!shouldContinue()) throw new Error('Offline download was stopped.');
    await pruneOfflinePin(pin.principal, pin.space, pin.folderId, current);
    if (!await updateOfflinePinStatus(pin, 'ready')) throw new Error('Offline download was stopped.');
    return progress;
  } catch (error) {
    const status = error instanceof ApiError || error instanceof OfflineContentHttpError ? error.status : null;
    if (status === 401) await clearMirror().catch(() => {});
    // If the folder itself disappeared or access was revoked, no old cached bytes may
    // remain readable after this online check. A temporary outage keeps the old copy.
    if (status === 403 || status === 404) {
      await removeOfflinePin(pin.principal, pin.space, pin.folderId).catch(() => {});
    } else {
      await updateOfflinePinStatus(pin, 'error').catch(() => {});
    }
    throw error;
  }
}

const refreshes = new Map<string, Promise<void>>();
const lastRefresh = new Map<string, number>();
/** Refresh device pins after an online listing, without launching a walk per render. */
export function refreshOfflinePins(principal: string, space: string): Promise<void> {
  const key = `${principal}\n${space}`;
  const running = refreshes.get(key);
  if (running) return running;
  if (Date.now() - (lastRefresh.get(key) ?? 0) < 30_000) return Promise.resolve();
  const run = (async () => {
    const pins = await listOfflinePins(principal, space);
    for (const pin of pins) {
      try { await syncOfflineFolder(pin); }
      catch { /* The pin records its error and can be retried from the folder. */ }
    }
    lastRefresh.set(key, Date.now());
  })().finally(() => { if (refreshes.get(key) === run) refreshes.delete(key); });
  refreshes.set(key, run);
  return run;
}
