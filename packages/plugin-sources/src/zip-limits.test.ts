import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { DEFAULT_ZIP_LIMITS, resolvePlugin, resolveZipBytes } from './index';
const source = { type: 'zip' as const, key: 'upload' };
const manifest = JSON.stringify({ id: 'demo', name: 'Demo', version: '1', capabilities: [] });
const archive = (extra: Record<string, string> = {}, level: 0 | 6 = 6) => zipSync(Object.fromEntries(Object.entries({
  'canopy.json': manifest, 'index.js': 'export default 1', ...extra,
}).map(([key, text]) => [key, strToU8(text)])), { level });
describe('ZIP import budgets', () => {
  it('accepts an archive exactly at a tightened input limit', () => {
    const bytes = archive(); expect(resolveZipBytes(bytes, source, { maxArchiveBytes: bytes.length }).manifest.id).toBe('demo');
    expect(() => resolveZipBytes(bytes, source, { maxArchiveBytes: bytes.length - 1 })).toThrow('archive byte');
  });
  it('counts directory entries and non-code files toward the entry limit', () => {
    expect(() => resolveZipBytes(archive({ 'dir/': '', 'readme.md': 'docs' }), source, { maxEntries: 3 })).toThrow('entry count');
  });
  it.each([0, 6] as const)('bounds stored and highly compressed entries before output allocation (level=%s)', level => {
    const bytes = archive({ 'large.js': 'x'.repeat(10000) }, level);
    expect(() => resolveZipBytes(bytes, source, { maxEntryBytes: 1000 })).toThrow('entry byte');
  });
  it('bounds the total across individually acceptable entries', () => {
    expect(() => resolveZipBytes(archive({ 'a.js': 'x'.repeat(100), 'b.js': 'x'.repeat(100) }), source,
      { maxEntryBytes: 150, maxTotalBytes: 200 })).toThrow('total byte');
  });
  it.each([0, -1, NaN, Infinity, 1.5, DEFAULT_ZIP_LIMITS.maxEntries + 1])('refuses invalid or widening limits: %s', maxEntries => {
    expect(() => resolveZipBytes(archive(), source, { maxEntries })).toThrow('invalid ZIP limit');
  });
  it('threads per-import limits through the unified resolver', async () => {
    await expect(resolvePlugin(source, { readZip: async () => archive(), zipLimits: { maxEntries: 1 } })).rejects.toThrow('entry count');
  });
});
