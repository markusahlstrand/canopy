import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkUpdate, resolvePlugin } from './index';

afterEach(() => vi.unstubAllGlobals());
function registry(tags: Record<string, string>, versions = { '1.0.0': {}, '2.0.0': {} }) {
  const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(
    url.startsWith('https://registry.npmjs.org/') ? { 'dist-tags': tags, versions } :
      { canopy: { id: 'example', name: 'Example', version: 'ignored' } },
  ), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
describe('npm plugin version resolution', () => {
  it.each([['1.0.0', '1.0.0'], ['beta', '1.0.0'], [undefined, '2.0.0']])(
    'resolves %s to a concrete published version', async (version, expected) => {
      const fetcher = registry({ latest: '2.0.0', beta: '1.0.0' });
      const resolved = await resolvePlugin({ type: 'npm', name: '@example/plugin', version });
      expect(resolved.version).toBe(expected);
      expect(resolved.manifest.version).toBe(expected);
      expect('url' in resolved.entry ? resolved.entry.url : undefined).toBe(`https://esm.sh/@example/plugin@${expected}`);
      expect(fetcher.mock.calls[1]?.[0]).toBe(`https://cdn.jsdelivr.net/npm/@example/plugin@${expected}/package.json`);
    },
  );
  it.each(['9.0.0', 'missing', '', 'toString'])('never substitutes latest for an unavailable pin: %s', async (version) => {
    const fetcher = registry({ latest: '2.0.0' });
    await expect(resolvePlugin({ type: 'npm', name: 'example', version })).rejects.toThrow('unavailable');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each<Record<string, string>>([{}, { latest: '9.0.0' }])('rejects missing or dangling latest tags', async (tags) => {
    registry(tags);
    await expect(resolvePlugin({ type: 'npm', name: 'example' })).rejects.toThrow('unavailable');
  });
  it('checks latest updates independently of an installation pin', async () => {
    registry({ latest: '2.0.0' });
    expect(await checkUpdate({ type: 'npm', name: 'example', version: '1.0.0' }, '1.0.0'))
      .toEqual({ current: '1.0.0', latest: '2.0.0' });
  });
});
