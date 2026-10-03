import { afterEach, expect, it, vi } from 'vitest';
import { resolvePlugin } from './index';
afterEach(() => vi.unstubAllGlobals());
const source = { type: 'github' as const, repo: 'acme/plugin', ref: 'v1.2.3', path: 'plugins/foo' };
function stub(entry = 'src/main.js') {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'demo', version: '1.2.3', entry })));
  vi.stubGlobal('fetch', fetcher); return fetcher;
}
it('keeps a canonical entry in the pinned repository and plugin directory', async () => {
  const fetcher = stub(); const result = await resolvePlugin(source);
  expect(fetcher.mock.calls[0]).toEqual(['https://raw.githubusercontent.com/acme/plugin/v1.2.3/plugins/foo/canopy.json', expect.anything()]);
  expect(result.entry).toEqual({ url: 'https://raw.githubusercontent.com/acme/plugin/v1.2.3/plugins/foo/src/main.js' });
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
  stub(); const result = await resolvePlugin({ ...source, ref: 'feature/nested' });
  expect(result.entry).toEqual({ url: 'https://raw.githubusercontent.com/acme/plugin/feature%2Fnested/plugins/foo/src/main.js' });
});
