import { expect, it, vi } from 'vitest';
import { resolvePlugin } from '@canopy/plugin-sources';
import { importNpmPlugin } from './npm-plugin-import';

vi.mock('@canopy/plugin-sources', () => ({ resolvePlugin: vi.fn(async () => ({
  manifest: { id: 'sample', name: 'Sample', version: '2.0.0' },
  entry: { url: 'https://esm.sh/@owner/plugin@2.0.0' },
  version: '2.0.0',
})) }));

it('resolves an npm tag and returns pinned provenance for review', async () => {
  const result = await importNpmPlugin({ name: '@owner/plugin', version: 'next' }, vi.fn(async () => new Response('export default () => {}')));
  expect(resolvePlugin).toHaveBeenCalledWith({ type: 'npm', name: '@owner/plugin', version: 'next' });
  expect(result.provenance).toEqual({ kind: 'npm', ref: '@owner/plugin@next', resolved: '2.0.0' });
  expect(result.source).toContain('export default');
});

it('rejects an oversized npm entry before loading it', async () => {
  await expect(importNpmPlugin({ name: '@owner/plugin' }, vi.fn(async () => new Response('x', { headers: { 'content-length': '256001' } })))).rejects.toThrow('too large');
});
