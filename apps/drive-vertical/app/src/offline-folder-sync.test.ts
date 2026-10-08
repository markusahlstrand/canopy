import 'fake-indexeddb/auto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ApiError, type DriveFile, type DriveFolder, type FileVersion } from './api';
import { cacheOfflineVersion, clearOfflineContent, getOfflineVersion, listOfflinePins, resumeOfflineContent, setOfflinePin } from './offline-content';
import { refreshOfflinePins, syncOfflineFolder, syncOfflineFolderOnce, type OfflineFolderSource } from './offline-folder-sync';

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

it('marks a failed walk partial when some files remain saved', async () => {
  const source: OfflineFolderSource = {
    async folders() { return { entries: [], next: null }; },
    async files(_id, next) {
      if (next) throw new TypeError('network lost');
      return { entries: [file('report', 'root', 'v1')], next: '/next' };
    },
    async versions() { return { versions: [version('v1', 'report')], next: null }; },
    contentUrl() { return '/content'; },
  };
  await expect(syncOfflineFolder(pin, source)).rejects.toThrow('network lost');
  expect((await listOfflinePins('alice', 'family'))[0]?.status).toBe('partial');
  expect(await getOfflineVersion({ principal: 'alice', space: 'family', fileId: 'report', versionId: 'v1' })).not.toBeNull();
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

it('retains a trailing refresh for changes inside the throttle window', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  let latest = 'v1';
  const source: OfflineFolderSource = {
    async folders() { return { entries: [], next: null }; },
    async files() { return { entries: [file('report', 'root', latest)], next: null }; },
    async versions() { return { versions: [version(latest, 'report')], next: null }; },
    contentUrl() { return '/content'; },
  };
  try {
    await refreshOfflinePins('alice', 'family', source);
    latest = 'v2';
    const trailing = refreshOfflinePins('alice', 'family', source);
    // IDB resolves asynchronously outside the mocked timer queue.
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0), { interval: 1 });
    await vi.advanceTimersByTimeAsync(30_000);
    await trailing;
    expect(await getOfflineVersion({ principal: 'alice', space: 'family', fileId: 'report', versionId: 'v1' })).toBeNull();
    expect(await getOfflineVersion({ principal: 'alice', space: 'family', fileId: 'report', versionId: 'v2' })).not.toBeNull();
  } finally { vi.useRealTimers(); }
});

it('reports a background failure even if full storage rejects persisting the partial status', async () => {
  const original = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
    const request = original.apply(this, args);
    if (this.name === 'pins' && args[0]?.status === 'partial') {
      const tx = this.transaction as unknown as { _requests: { operation: () => unknown }[] };
      tx._requests.at(-1)!.operation = () => { throw new DOMException('Storage full', 'QuotaExceededError'); };
    }
    return request;
  });
  const failure = new TypeError('download failed');
  const source: OfflineFolderSource = {
    async folders() { return { entries: [], next: null }; },
    async files(_id, next) { if (next) throw failure; return { entries: [file('report', 'root', 'v1')], next: '/next' }; },
    async versions() { return { versions: [version('v1', 'report')], next: null }; },
    contentUrl() { return '/content'; },
  };
  const updated = vi.fn();
  try {
    await refreshOfflinePins('alice', 'family', source, updated);
    expect(updated).toHaveBeenCalledWith(failure);
    expect((await listOfflinePins('alice', 'family'))[0]?.status).toBe('syncing');
    expect(await getOfflineVersion({ principal: 'alice', space: 'family', fileId: 'report', versionId: 'v1' })).not.toBeNull();
  } finally { spy.mockRestore(); }
});
