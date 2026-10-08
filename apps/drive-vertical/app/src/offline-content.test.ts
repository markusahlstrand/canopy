import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cacheOfflineVersion, clearOfflineContent, getOfflineVersion, listOfflinePins,
  offlineSessionEpoch, offlineSpace, pruneOfflinePin, rememberOfflineSpace, removeOfflinePin, resumeOfflineContent, setOfflinePin,
} from './offline-content';

const key = (principal = 'alice', space = 'family', versionId = 'v1') => ({
  principal, space, fileId: 'file', versionId, folderId: 'docs', name: 'note.txt', mime: 'text/plain', url: '/api/files/file/versions/v1/content',
});
const fetcher = async () => new Response('hello', { headers: { 'content-type': 'text/plain' } });

beforeEach(async () => {
  await clearOfflineContent();
  await resumeOfflineContent();
  await setOfflinePin({ principal: 'alice', space: 'family', folderId: 'docs', name: 'Docs', status: 'syncing', updatedAt: 1 });
});

describe('opt-in offline content store', () => {
  it('keeps pins and bytes scoped to principal, space, and immutable version', async () => {
    await setOfflinePin({ principal: 'alice', space: 'family', folderId: 'docs', name: 'Docs', status: 'syncing', updatedAt: 1 });
    await cacheOfflineVersion(key(), fetcher);
    expect((await getOfflineVersion(key()))?.name).toBe('note.txt');
    expect(await getOfflineVersion(key('bob'))).toBeNull();
    expect(await getOfflineVersion(key('alice', 'work'))).toBeNull();
    expect(await getOfflineVersion(key('alice', 'family', 'v2'))).toBeNull();
    expect(await listOfflinePins('alice', 'family')).toHaveLength(1);
    expect(await listOfflinePins('alice', 'work')).toHaveLength(0);
  });

  it('drops bytes when their last folder pin is removed', async () => {
    await setOfflinePin({ principal: 'alice', space: 'family', folderId: 'docs', name: 'Docs', status: 'ready', updatedAt: 1 });
    await cacheOfflineVersion(key(), fetcher);
    await removeOfflinePin('alice', 'family', 'docs');
    expect(await listOfflinePins('alice', 'family')).toHaveLength(0);
    expect(await getOfflineVersion(key())).toBeNull();
  });

  it('remembers the actual scope behind the hostname for offline reloads and clears it on logout', async () => {
    await rememberOfflineSpace('alice', '', 'family');
    expect(await offlineSpace('alice', '')).toBe('family');
    expect(await offlineSpace('bob', '')).toBeNull();
    await clearOfflineContent();
    await resumeOfflineContent();
    expect(await offlineSpace('alice', '')).toBeNull();
  });

  it('purges the previous principal when the browser signs into a different account', async () => {
    await resumeOfflineContent('alice');
    await cacheOfflineVersion(key(), fetcher);
    await resumeOfflineContent('bob');
    expect(await getOfflineVersion(key())).toBeNull();
    expect(await listOfflinePins('alice', 'family')).toEqual([]);
  });

  it('refuses an in-flight download after sign-out and cannot reveal old bytes after re-authentication', async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(r => { resolve = r; });
    const download = cacheOfflineVersion(key(), () => pending);
    await Promise.resolve();
    await clearOfflineContent();
    resolve(new Response('late'));
    await expect(download).rejects.toThrow('offline session ended');
    await resumeOfflineContent();
    expect(await getOfflineVersion(key())).toBeNull();
  });

  it('does not let an old session prune or remove bytes from a new login of the same person', async () => {
    const oldEpoch = await offlineSessionEpoch();
    await clearOfflineContent();
    await resumeOfflineContent('alice');
    await setOfflinePin({ principal: 'alice', space: 'family', folderId: 'docs', name: 'Docs', status: 'ready', updatedAt: 2 });
    await cacheOfflineVersion(key(), fetcher);

    await expect(pruneOfflinePin('alice', 'family', 'docs', new Set(), oldEpoch))
      .rejects.toThrow('offline session ended');
    await expect(removeOfflinePin('alice', 'family', 'docs', oldEpoch))
      .rejects.toThrow('offline session ended');
    expect(await getOfflineVersion(key())).not.toBeNull();
    expect((await listOfflinePins('alice', 'family'))[0]?.status).toBe('ready');
  });

  it('rejects a file above the per-file limit without storing a partial copy', async () => {
    await expect(cacheOfflineVersion(key(), async () => new Response(new Uint8Array(20_000_001))))
      .rejects.toThrow('20 MB offline file limit');
    expect(await getOfflineVersion(key())).toBeNull();
  });

  it('explains browser storage exhaustion during a save', async () => {
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'versions') throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return put.apply(this, args);
    });
    try {
      await expect(cacheOfflineVersion(key(), fetcher)).rejects.toThrow('browser is out of storage space');
    } finally {
      spy.mockRestore();
    }
    expect(await getOfflineVersion(key())).toBeNull();
  });
});
