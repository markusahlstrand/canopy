import { afterEach, expect, it, vi } from 'vitest';
import { resolvePlugin } from './index';
afterEach(() => vi.unstubAllGlobals());
const sha = 'a'.repeat(40);
const source = { type: 'github' as const, repo: 'acme/plugin', ref: 'v1.2.3', path: 'plugins/foo' };
function stub(entry = 'src/main.js') {
  const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith('https://api.github.com/') ? { sha } : { id: 'demo', version: '1.2.3', entry })));
  vi.stubGlobal('fetch', fetcher); return fetcher;
}
it('keeps a canonical entry in the pinned repository and plugin directory', async () => {
  const fetcher = stub(); const result = await resolvePlugin(source);
  expect(fetcher.mock.calls[0]).toEqual(['https://api.github.com/repos/acme/plugin/commits/v1.2.3', expect.anything()]);
  expect(fetcher.mock.calls[1]).toEqual([`https://raw.githubusercontent.com/acme/plugin/${sha}/plugins/foo/canopy.json`, expect.anything()]);
  expect(result.entry).toEqual({ url: `https://raw.githubusercontent.com/acme/plugin/${sha}/plugins/foo/src/main.js` });
});
it.each(['../../../../../evil/repo/main/x.js', '../other.js', '/outside.js', './main.js', 'src//main.js', 'src\\main.js'])('rejects entry aliases and traversal: %s', entry => {
  stub(entry); return expect(resolvePlugin(source)).rejects.toThrow('plain relative');
});
it.each([{ path: '../other' }, { path: '/plugins' }, { ref: '../main' }, { ref: './main' }, { repo: 'acme/plugin/../../evil' }])(
  'rejects invalid source paths before a network request: %s', async override => {
    const fetcher = stub(); await expect(resolvePlugin({ ...source, ...override })).rejects.toThrow('invalid GitHub');
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it('encodes slash-bearing refs as a single URL segment', async () => {
  const fetcher = stub(); const result = await resolvePlugin({ ...source, ref: 'feature/nested' });
  expect(fetcher.mock.calls[0]![0]).toBe('https://api.github.com/repos/acme/plugin/commits/feature%2Fnested');
  expect(result.entry).toEqual({ url: `https://raw.githubusercontent.com/acme/plugin/${sha}/plugins/foo/src/main.js` });
});

it('uses a full commit pin without a ref lookup and retains the update channel', async () => {
  const fetcher = stub(); const result = await resolvePlugin({ ...source, ref: sha.toUpperCase() });
  expect(fetcher).toHaveBeenCalledOnce(); expect(result.source).toEqual({ ...source, ref: sha.toUpperCase() });
  expect(result.entry).toEqual({ url: `https://raw.githubusercontent.com/acme/plugin/${sha}/plugins/foo/src/main.js` });
});
it.each([{}, { sha: '../main' }])('refuses an invalid commit response before fetching code', async response => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(response))); vi.stubGlobal('fetch', fetcher);
  await expect(resolvePlugin(source)).rejects.toThrow('commit SHA'); expect(fetcher).toHaveBeenCalledOnce();
});
it('does not fall back to a moving branch when GitHub refuses the ref lookup', async () => {
  const fetcher = vi.fn(async () => new Response('rate limited', { status: 429 })); vi.stubGlobal('fetch', fetcher);
  await expect(resolvePlugin(source)).rejects.toThrow('429'); expect(fetcher).toHaveBeenCalledOnce();
});
