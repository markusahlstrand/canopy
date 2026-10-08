import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { clearOfflineContent, getOfflineVersion, resumeOfflineContent, setOfflinePin } from './offline-content';
import { syncOfflineFolder, type OfflineFolderSource } from './offline-folder-sync';

afterEach(() => vi.unstubAllGlobals());
it('refreshes a renamed file without downloading its unchanged version again', async () => {
  await clearOfflineContent(); await resumeOfflineContent('alice');
  const pin = { principal: 'alice', space: 'family', folderId: 'root', name: 'Root', status: 'syncing' as const, updatedAt: 1 };
  await setOfflinePin(pin);
  const fetcher = vi.fn(async () => new Response('saved bytes')); vi.stubGlobal('fetch', fetcher);
  let name = 'old.txt';
  const source: OfflineFolderSource = {
    async folders() { return { entries: [], next: null }; },
    async files() { return { entries: [{ id: 'file', folder_id: 'root', name, current_version_id: 'v1', created_at: '', updated_at: '', deleted_at: null }], next: null }; },
    async versions() { return { versions: [{ id: 'v1', file_id: 'file', mime: 'text/plain', size: 11, source: 'blob', blob_ref: null, keep: 0, created_at: '' }], next: null }; },
    contentUrl() { return '/content'; },
  };
  const key = { principal: 'alice', space: 'family', fileId: 'file', versionId: 'v1' };
  await syncOfflineFolder(pin, source);
  const before = await getOfflineVersion(key);
  name = 'renamed.txt'; await syncOfflineFolder(pin, source);
  const after = await getOfflineVersion(key);
  expect(after?.name).toBe('renamed.txt');
  expect(after?.bytes).toEqual(before?.bytes);
  expect(after?.savedAt).toBe(before?.savedAt);
  expect(fetcher).toHaveBeenCalledOnce();
});
