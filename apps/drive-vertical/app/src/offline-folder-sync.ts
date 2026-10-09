import {
  ApiError, fileVersionsPage, listFolderPage, listFoldersPage, versionContentUrl,
  type DriveFile, type DriveFolder, type FileVersion, type ListingPage,
} from './api';
import {
  cacheOfflineVersion, getOfflineVersion, hasOfflinePinBytes, listOfflinePins, offlineSessionEpoch, OfflineContentHttpError, pruneOfflinePin, removeOfflinePin,
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

/** Find the file's current version across paged version history. */
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
  expectedEpoch?: number,
): Promise<FolderSyncProgress> {
  const epoch = expectedEpoch ?? await offlineSessionEpoch();
  if (!await updateOfflinePinStatus(pin, 'syncing', epoch)) throw new Error('This folder is no longer marked for offline access.');
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
          if (!cached || !await retainOfflineVersion(key, pin.folderId, epoch, { name: file.name })) {
            await cacheOfflineVersion({ ...key, folderId: pin.folderId, name: file.name, mime: version.mime,
              url: source.contentUrl(file.id, version.id, pin.space) }, fetch, epoch);
          }
          current.add(`${file.id}\n${version.id}`);
          progress.files++;
          onProgress({ ...progress });
        }
        next = page.next;
      } while (next);
    }
    if (!shouldContinue()) throw new Error('Offline download was stopped.');
    await pruneOfflinePin(pin.principal, pin.space, pin.folderId, current, epoch);
    if (!await updateOfflinePinStatus(pin, 'ready', epoch)) throw new Error('Offline download was stopped.');
    return progress;
  } catch (error) {
    const status = error instanceof ApiError || error instanceof OfflineContentHttpError ? error.status : null;
    if (status === 401 && (await offlineSessionEpoch().catch(() => null)) === epoch) {
      await clearMirror().catch(() => {});
    }
    // If the folder itself disappeared or access was revoked, no old cached bytes may
    // remain readable after this online check. A temporary outage keeps the old copy.
    if (status === 403 || status === 404) {
      await removeOfflinePin(pin.principal, pin.space, pin.folderId, epoch).catch(() => {});
    } else {
      const partial = await hasOfflinePinBytes(pin.principal, pin.space, pin.folderId).catch(() => false);
      await updateOfflinePinStatus(pin, partial ? 'partial' : 'error', epoch).catch(() => {});
    }
    throw error;
  }
}

const inFlightPins = new Map<string, Promise<FolderSyncProgress>>();
/** Share one walk per pin and login generation between manual saves and background refreshes. */
export async function syncOfflineFolderOnce(
  pin: FolderPin,
  source: OfflineFolderSource = liveOfflineFolderSource,
  onProgress: (progress: FolderSyncProgress) => void = () => {},
  shouldContinue: () => boolean = () => true,
  expectedEpoch?: number,
): Promise<FolderSyncProgress> {
  const epoch = expectedEpoch ?? await offlineSessionEpoch();
  const key = `${epoch}\n${pin.principal}\n${pin.space}\n${pin.folderId}`;
  const running = inFlightPins.get(key);
  if (running) return running;
  const run = syncOfflineFolder(pin, source, onProgress, shouldContinue, epoch)
    .finally(() => { if (inFlightPins.get(key) === run) inFlightPins.delete(key); });
  inFlightPins.set(key, run);
  return run;
}

const refreshes = new Map<string, { promise: Promise<void>; requested: boolean; shouldRun: () => boolean }>();
const lastRefresh = new Map<string, number>();
/**
 * Coalesce listings, retaining a trailing refresh instead of dropping changes during the throttle.
 * `shouldRun` is re-checked when a delayed walk fires and before each pin: the caller's
 * conditions (online, idle, still on the drive) may have changed since it asked.
 */
export async function refreshOfflinePins(
  principal: string,
  space: string,
  source = liveOfflineFolderSource,
  onUpdated: (error?: unknown, pin?: FolderPin) => void | Promise<void> = () => {},
  shouldRun: () => boolean = () => true,
): Promise<void> {
  const epoch = await offlineSessionEpoch();
  const key = `${epoch}\n${principal}\n${space}`;
  const running = refreshes.get(key);
  if (running) { running.requested = true; running.shouldRun = shouldRun; return running.promise; }
  const state = { promise: Promise.resolve(), requested: true, shouldRun };
  state.promise = (async () => {
    while (state.requested) {
      state.requested = false;
      const previous = lastRefresh.get(key);
      const remaining = previous === undefined ? 0 : 30_000 - (Date.now() - previous);
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
      if (await offlineSessionEpoch().catch(() => null) !== epoch) return;
      // Requests arriving while waiting are covered by this walk. Requests arriving
      // during the walk may describe newer data and need another trailing walk.
      state.requested = false;
      const pins = await listOfflinePins(principal, space);
      for (const pin of pins) {
        if (!state.shouldRun()) return;
        try { await syncOfflineFolderOnce(pin, source, progress => { if (progress.files === 0) void onUpdated(); }, undefined, epoch); }
        catch (error) {
          // A walk cut off by losing the connection leaves the last complete copy intact.
          if (pin.status === 'ready' && error instanceof TypeError && !state.shouldRun() &&
              await updateOfflinePinStatus(pin, 'ready', epoch).catch(() => false)) {
            await onUpdated();
            return;
          }
          // Full storage can also reject persisting partial/error status. Report
          // the failure to the live UI even if that last status write failed.
          await onUpdated(error, pin);
          continue;
        }
        await onUpdated(null, pin);
      }
      lastRefresh.set(key, Date.now());
    }
  })().finally(() => { if (refreshes.get(key) === state) refreshes.delete(key); });
  refreshes.set(key, state);
  return state.promise;
}
