import 'fake-indexeddb/auto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { getFile, selectSite } from './api';
import { cacheOfflineVersion, clearOfflineContent, getOfflineVersion, resumeOfflineContent, setOfflinePin } from './offline-content';
import { clearMirror } from './scope-mirror';
vi.mock('./scope-mirror', () => ({ clearMirror: vi.fn(async () => {}) }));
const key = { principal: 'alice', space: 'family', fileId: 'report', versionId: 'v1' };
async function save(principal: string) {
  await resumeOfflineContent(principal);
  await setOfflinePin({ principal, space: 'family', folderId: 'root', name: 'Family', status: 'ready', updatedAt: 1 });
  await cacheOfflineVersion({ ...key, principal, folderId: 'root', name: 'report.txt', mime: 'text/plain', url: '/content' }, async () => new Response('saved bytes'));
}
beforeEach(async () => { selectSite(null); vi.clearAllMocks(); await clearOfflineContent(); await save('alice'); });
afterEach(() => vi.unstubAllGlobals());
it('invalidates cached access after a refused file metadata read', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'not a member' }), { status: 401 })));
  await expect(getFile('report')).rejects.toMatchObject({ status: 401 });
  expect(clearMirror).toHaveBeenCalledOnce();
});
it('does not let a late refusal invalidate a different login', async () => {
  let reply!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { reply = resolve; })));
  const old = getFile('report');
  await clearOfflineContent();
  await save('bob');
  reply(new Response(JSON.stringify({ detail: 'old session refused' }), { status: 401 }));
  await expect(old).rejects.toMatchObject({ status: 401 });
  expect(clearMirror).not.toHaveBeenCalled();
  expect(await getOfflineVersion({ ...key, principal: 'bob' })).not.toBeNull();
});
