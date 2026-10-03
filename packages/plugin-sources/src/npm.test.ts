import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkUpdate, resolvePlugin } from './index';

afterEach(() => vi.unstubAllGlobals());
function registry(tags: Record<string, string>, versions: Record<string, unknown> = { '1.0.0': {}, '2.0.0': {} }) {
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

it.each(['left-pad?x=', 'left-pad#fragment', '@a/b/../../c', '../plugin', 'a/b', '@scope/../plugin', 'Uppercase', 'a'.repeat(215)])(
  'rejects malformed package names before install or update requests: %s', async name => {
    const fetcher = registry({ latest: '2.0.0' });
    await expect(resolvePlugin({ type: 'npm', name, version: '1.0.0' })).rejects.toThrow('Invalid npm package name');
    await expect(checkUpdate({ type: 'npm', name }, '1.0.0')).rejects.toThrow('Invalid npm package name');
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it('checks a dist-tag against its own channel instead of stable latest', async () => {
  registry({ latest: '2.0.0', next: '3.0.0-rc.2' }, { '1.0.0': {}, '2.0.0': {}, '3.0.0-rc.2': {} });
  expect(await checkUpdate({ type: 'npm', name: 'example', version: 'next' }, '3.0.0-rc.1'))
    .toEqual({ current: '3.0.0-rc.1', latest: '3.0.0-rc.2' });
  expect(await checkUpdate({ type: 'npm', name: 'example', version: 'next' }, '3.0.0-rc.2')).toBeNull();
});
it('refuses a disappeared tag instead of replacing its channel with latest', async () => {
  registry({ latest: '2.0.0' });
  await expect(checkUpdate({ type: 'npm', name: 'example', version: 'next' }, '3.0.0-rc.1')).rejects.toThrow('unavailable');
});
