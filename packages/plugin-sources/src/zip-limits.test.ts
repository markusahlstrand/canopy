import { describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8, Inflate, Zip, ZipDeflate } from 'fflate';
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

// Patch real ZIP records rather than relying on a writer to emit inconsistent metadata.
function records(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: { central: number; local: number; name: string }[] = [];
  for (let offset = 0; offset + 46 <= bytes.length; offset++) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    result.push({ central: offset, local: view.getUint32(offset + 42, true), name: new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + view.getUint16(offset + 28, true))) });
  }
  return result;
}
it('defaults explicitly undefined limits and validates before invoking the provider', async () => {
  expect(resolveZipBytes(archive(), source, { maxEntries: undefined }).manifest.id).toBe('demo');
  const readZip = vi.fn(async () => archive());
  await resolvePlugin(source, { readZip, zipLimits: { maxArchiveBytes: 1000 } });
  expect(readZip).toHaveBeenCalledExactlyOnceWith('upload', { maxBytes: 1000 });
  readZip.mockClear();
  await expect(resolvePlugin(source, { readZip, zipLimits: { maxEntries: -1 } })).rejects.toThrow('invalid ZIP limit');
  expect(readZip).not.toHaveBeenCalled();
});
it.each([10, 1_000_001])('rejects false inflated sizes instead of silently truncating or padding (%s)', declared => {
  const bytes = archive({ 'large.js': 'x'.repeat(1_000_000) });
  const record = records(bytes).find(record => record.name === 'large.js')!;
  const view = new DataView(bytes.buffer); view.setUint32(record.central + 24, declared, true); view.setUint32(record.local + 22, declared, true);
  const pushes = vi.spyOn(Inflate.prototype, 'push');
  try {
    expect(() => resolveZipBytes(bytes, source)).toThrow(/size.*mismatch/);
    // An overrun stops after a small input chunk, rather than decoding the whole bomb.
    if (declared === 10) expect(pushes.mock.calls.length).toBeLessThan(8);
  } finally { pushes.mockRestore(); }
});
it('rejects central/local size disagreements and corrupted checksums', () => {
  const bytes = archive(); const record = records(bytes).find(record => record.name === 'index.js')!; const view = new DataView(bytes.buffer);
  view.setUint32(record.central + 24, 1, true);
  expect(() => resolveZipBytes(bytes, source)).toThrow('ZIP structure');
  view.setUint32(record.central + 24, view.getUint32(record.local + 22, true), true);
  view.setUint32(record.central + 16, 0, true); view.setUint32(record.local + 14, 0, true);
  expect(() => resolveZipBytes(bytes, source)).toThrow('checksum mismatch');
});
it('rejects distinctly named central entries pointing at the same local header', () => {
  const bytes = archive({ 'other.js': 'export default 1' }); const rows = records(bytes);
  const first = rows.find(record => record.name === 'index.js')!, second = rows.find(record => record.name === 'other.js')!;
  new DataView(bytes.buffer).setUint32(second.central + 42, first.local, true);
  expect(() => resolveZipBytes(bytes, source)).toThrow('ZIP structure');
});
it('rejects partially overlapping local records even when all names and checksums agree', () => {
  const inner = zipSync({ 'index.js': strToU8('export default 1') }, { level: 0 });
  const bytes = zipSync({ 'canopy.json': strToU8(manifest), 'outer.bin': inner, 'index.js': strToU8('export default 1') }, { level: 0 });
  const rows = records(bytes), view = new DataView(bytes.buffer);
  const outer = rows.find(record => record.name === 'outer.bin')!;
  const index = rows.at(-1)!;
  const nestedLocal = outer.local + 30 + view.getUint16(outer.local + 26, true) + view.getUint16(outer.local + 28, true);
  view.setUint32(index.central + 42, nestedLocal, true);
  expect(() => resolveZipBytes(bytes, source)).toThrow('overlapping local entries');
});
it('accepts streaming writers with descriptors and UTF-8 module names', () => {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, data) => { if (error) throw error; chunks.push(data); });
  for (const [name, text] of Object.entries({ 'canopy.json': manifest, 'index.js': 'export default 1', 'café.js': 'export const x = 1' })) {
    const file = new ZipDeflate(name); zip.add(file); file.push(strToU8(text), true);
  }
  zip.end();
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0)); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  expect(resolveZipBytes(bytes, source).entry).toMatchObject({ modules: { 'café.js': 'export const x = 1' } });
});
