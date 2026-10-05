import { expect, it, vi } from 'vitest';
import { resolvePlugin } from '@canopy/plugin-sources';
import { importNpmPlugin } from './npm-plugin-import';

vi.mock('@canopy/plugin-sources', () => ({ resolvePlugin: vi.fn(async () => ({
  manifest: { id: 'sample', name: 'Sample', version: '2.0.0' },
  entry: { code: 'export default () => {}' },
  version: '2.0.0',
  integrity: 'sha512-archive',
})) }));

it('resolves an npm tag and returns pinned provenance for review', async () => {
  const result = await importNpmPlugin({ name: '@owner/plugin', version: 'next' }, vi.fn(async () => new Response('export default () => {}')));
  expect(resolvePlugin).toHaveBeenCalledWith({ type: 'npm', name: '@owner/plugin', version: 'next' }, { fetch: expect.any(Function) });
  expect(result.provenance).toEqual({ kind: 'npm', ref: '@owner/plugin@next', resolved: '2.0.0 sha512-archive' });
  expect(result.source).toContain('export default');
});

it('rejects a resolver result without verified archive integrity', async () => {
  vi.mocked(resolvePlugin).mockResolvedValueOnce({
    manifest: { id: 'sample', name: 'Sample', version: '2.0.0', capabilities: [] }, entry: { code: 'export default () => {}' },
    version: '2.0.0', source: {type: 'npm', name: '@owner/plugin'},
  });
  await expect(importNpmPlugin({ name: '@owner/plugin' }, vi.fn())).rejects.toThrow('verified');
});
