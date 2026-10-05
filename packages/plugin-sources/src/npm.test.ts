import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkUpdate, resolvePlugin } from './index';
import { readNpmTarball } from './npm-tarball';

vi.mock('./npm-tarball', () => ({ readNpmTarball: vi.fn(async () => ({
  manifest: { id: 'example', name: 'Example', version: 'ignored' }, source: 'export default () => {}',
})) }));

afterEach(() => vi.unstubAllGlobals());
function registry(tags: Record<string, string>, versions: Record<string, unknown> = { '1.0.0': {dist:{tarball:'https://registry.npmjs.org/example/-/example-1.0.0.tgz',integrity:'sha512-test'}}, '2.0.0': {dist:{tarball:'https://registry.npmjs.org/example/-/example-2.0.0.tgz',integrity:'sha512-test'}} }) {
  const fetcher = vi.fn(async (url: string, _options?: RequestInit) => new Response(JSON.stringify(
    { 'dist-tags': tags, versions },
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
      expect('code' in resolved.entry ? resolved.entry.code : undefined).toContain('export default');
      expect(resolved.integrity).toBe('sha512-test');
      expect(readNpmTarball).toHaveBeenCalledWith(`https://registry.npmjs.org/example/-/example-${expected}.tgz`, 'sha512-test', expect.any(Function));
      expect(fetcher.mock.calls[0]?.[0]).toBe('https://registry.npmjs.org/@example/plugin');
      expect(fetcher).toHaveBeenCalledWith('https://registry.npmjs.org/@example/plugin', expect.objectContaining({
        headers: expect.objectContaining({Accept: 'application/vnd.npm.install-v1+json'}),
      }));
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

it('names oversized registry metadata in the error', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {headers:{'content-length': String(4 * 1024 * 1024 + 1)}})));
  await expect(resolvePlugin({type:'npm',name:'example'})).rejects.toThrow('npm registry metadata exceeds size limit');
});
