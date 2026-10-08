import 'fake-indexeddb/auto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ApiError, type DriveFile, type DriveFolder, type FileVersion } from './api';
import { cacheOfflineVersion, clearOfflineContent, getOfflineVersion, listOfflinePins, resumeOfflineContent, setOfflinePin } from './offline-content';
import { syncOfflineFolder, syncOfflineFolderOnce, type OfflineFolderSource } from './offline-folder-sync';

const pin = { principal: 'alice', space: 'family', folderId: 'root', name: 'Family', status: 'syncing' as const, updatedAt: 1 };
const file = (id: string, folder_id: string, version: string): DriveFile => ({
  id, folder_id, name: `${id}.txt`, current_version_id: version,
  created_at: '2026-10-07', updated_at: '2026-10-07', deleted_at: null,
});
const version = (id: string, file_id: string): FileVersion => ({
  id, file_id, mime: 'text/plain', size: 5, source: 'blob', blob_ref: null, keep: 0, created_at: '2026-10-07',
});

beforeEach(async () => {
  await clearOfflineContent(); await resumeOfflineContent(); await setOfflinePin(pin);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('hello')));
});
afterEach(() => vi.unstubAllGlobals());

it('walks paged nested folders, saves current versions, and removes a superseded version', async () => {
  let reportVersion = 'v1';
  const source: OfflineFolderSource = {
    async folders(id, next) {
      if (id === 'root' && !next) return { entries: [{ id: 'docs', parent_id: 'root', name: 'Docs', path: 'Docs' }] as DriveFolder[], next: '/next' };
      return { entries: [], next: null };
    },
    async files(id) { return { entries: id === 'docs' ? [file('report', 'docs', reportVersion)] : [], next: null }; },
    async versions(id) { return { versions: [version(reportVersion, id)], next: null }; },
    contentUrl(id, v) { return `/content/${id}/${v}`; },
  };
  const progress = await syncOfflineFolder(pin, source);
  expect(progress).toEqual({ folders: 2, files: 1 });
  expect((await listOfflinePins('alice', 'family'))[0]?.status).toBe('ready');
  expect(await getOfflineVersion({ principal: 'alice', space: 'family', fileId: 'report', versionId: 'v1' })).not.toBeNull();

  reportVersion = 'v2';
  await syncOfflineFolder(pin, source);
  expect(await getOfflineVersion({ principal: 'alice', space: 'family', fileId: 'report', versionId: 'v1' })).toBeNull();
  expect(await getOfflineVersion({ principal: 'alice', space: 'family', fileId: 'report', versionId: 'v2' })).not.toBeNull();
});

it('clears a pin and its bytes when a live permission check rejects it', async () => {
  const saved = { principal: 'alice', space: 'family', fileId: 'report', versionId: 'v1' };
  await cacheOfflineVersion({ ...saved, folderId: 'root', name: 'report.txt', mime: 'text/plain', url: '/content' });
  const source: OfflineFolderSource = {
    async folders() { throw new ApiError(403, 'no access'); },
    async files() { return { entries: [], next: null }; },
    async versions() { return { versions: [], next: null }; },
    contentUrl() { return '/content'; },
  };
  await expect(syncOfflineFolder(pin, source)).rejects.toThrow('no access');
  expect(await listOfflinePins('alice', 'family')).toEqual([]);
  expect(await getOfflineVersion(saved)).toBeNull();
});

it('keeps a failed pin visibly incomplete after a temporary outage', async () => {
  const source: OfflineFolderSource = {
    async folders() { throw new TypeError('offline'); },
    async files() { return { entries: [], next: null }; },
    async versions() { return { versions: [], next: null }; },
    contentUrl() { return '/content'; },
  };
  await expect(syncOfflineFolder(pin, source)).rejects.toThrow('offline');
  expect((await listOfflinePins('alice', 'family'))[0]?.status).toBe('error');
});

it('shares one walk when a manual save overlaps a background refresh', async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let walks = 0;
  const source: OfflineFolderSource = {
    async folders() { walks++; entered(); await blocked; return { entries: [], next: null }; },
    async files() { return { entries: [file('report', 'root', 'v1')], next: null }; },
    async versions() { return { versions: [version('v1', 'report')], next: null }; },
    contentUrl() { return '/content'; },
  };
  const background = syncOfflineFolderOnce(pin, source);
  await started;
  const manual = syncOfflineFolderOnce(pin, source);
  release();
  await Promise.all([background, manual]);
  expect(walks).toBe(1);
  expect((await listOfflinePins('alice', 'family'))[0]?.status).toBe('ready');
  expect(await getOfflineVersion({ principal: 'alice', space: 'family', fileId: 'report', versionId: 'v1' })).not.toBeNull();
});

it('does not let an old folder walk alter a new login of the same person', async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const source: OfflineFolderSource = {
    async folders() { entered(); await blocked; return { entries: [], next: null }; },
    async files() { return { entries: [], next: null }; },
    async versions() { return { versions: [], next: null }; },
    contentUrl() { return '/content'; },
  };
  const stale = syncOfflineFolderOnce(pin, source);
  await started;
  await clearOfflineContent();
  await resumeOfflineContent('alice');
  await setOfflinePin({ ...pin, status: 'ready' });
  const saved = { principal: 'alice', space: 'family', fileId: 'report', versionId: 'v1' };
  await cacheOfflineVersion({ ...saved, folderId: 'root', name: 'report.txt', mime: 'text/plain', url: '/content' });
  release();
  await expect(stale).rejects.toThrow('offline session ended');
  expect((await listOfflinePins('alice', 'family'))[0]?.status).toBe('ready');
  expect(await getOfflineVersion(saved)).not.toBeNull();
});
