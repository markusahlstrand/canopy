import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { resolvePlugin, resolveZipBytes } from './index';
const source = { type: 'zip' as const, key: 'upload' };
const manifest = (entry?: unknown) => JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0', capabilities: [], ...(entry === undefined ? {} : { entry }) });
const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, strToU8(value)])));

describe('ZIP plugin resolution', () => {
  it('loads a wrapped plugin with only sibling modules', () => {
    const result = resolveZipBytes(zip({ 'demo/': '', 'demo/canopy.json': manifest('src/main.js'),
      'demo/src/main.js': 'export default 1', 'demo/src/helper.js': 'export const x = 2',
      'elsewhere/secret.js': 'private', 'demo/readme.md': 'docs' }), source);
    expect(result.entry).toEqual({ code: 'export default 1', modules: { 'src/helper.js': 'export const x = 2' } });
    expect(result.version).toBe('1.0.0');
  });
  it('loads the default root entry through the readZip provider', async () => {
    const bytes = zip({ 'canopy.json': manifest(), 'index.js': 'export default 1' });
    expect((await resolvePlugin(source, { readZip: async key => { expect(key).toBe('upload'); return bytes; } })).entry)
      .toEqual({ code: 'export default 1', modules: undefined });
  });
  it('does not mistake a suffix filename for the manifest', () => {
    expect(() => resolveZipBytes(zip({ 'mycanopy.json': manifest(), 'index.js': '' }), source)).toThrow('no canopy.json');
  });
  it('refuses ambiguous manifests instead of depending on archive ordering', () => {
    expect(() => resolveZipBytes(zip({ 'canopy.json': manifest(), 'nested/canopy.json': manifest(), 'index.js': '' }), source)).toThrow('multiple');
  });
  it.each(['../main.js', '/main.js', './main.js', 'src//main.js', 'src/../main.js', 'src\\main.js', 'C:/main.js', '', 42])(
    'rejects a noncanonical entry: %s', entry => {
      expect(() => resolveZipBytes(zip({ 'canopy.json': manifest(entry), 'index.js': '' }), source)).toThrow('plain relative');
    },
  );
  it.each(['../outside.js', '/outside.js', './outside.js', 'src//outside.js', 'src\\outside.js'])('rejects noncanonical archive paths: %s', key => {
    expect(() => resolveZipBytes(zip({ 'canopy.json': manifest(), 'index.js': '', [key]: '' }), source)).toThrow('invalid path');
  });
  it('refuses a missing entry and a malformed manifest', () => {
    expect(() => resolveZipBytes(zip({ 'canopy.json': manifest('missing.js') }), source)).toThrow('missing entry');
    expect(() => resolveZipBytes(zip({ 'canopy.json': 'null' }), source)).toThrow('must be an object');
  });
});

// Python zipfile fixtures retain repeated central-directory entries, which
// zipSync's object input cannot represent.
it.each(['UEsDBBQAAAAAAFdcQ12r5CWhOwAAADsAAAALAAAAY2Fub3B5Lmpzb257ImlkIjoiZGVtbyIsIm5hbWUiOiJEZW1vIiwidmVyc2lvbiI6IjEiLCJjYXBhYmlsaXRpZXMiOltdfVBLAwQUAAAAAABXXENdukuwFQ0AAAANAAAACwAAAGNhbm9weS5qc29ueyJpZCI6ImV2aWwifVBLAwQUAAAAAABXXENdjyikHwQAAAAEAAAACAAAAGluZGV4Lmpzc2FmZVBLAQIUAxQAAAAAAFdcQ12r5CWhOwAAADsAAAALAAAAAAAAAAAAAACAAQAAAABjYW5vcHkuanNvblBLAQIUAxQAAAAAAFdcQ126S7AVDQAAAA0AAAALAAAAAAAAAAAAAACAAWQAAABjYW5vcHkuanNvblBLAQIUAxQAAAAAAFdcQ12PKKQfBAAAAAQAAAAIAAAAAAAAAAAAAACAAZoAAABpbmRleC5qc1BLBQYAAAAAAwADAKgAAADEAAAAAAA=', 'UEsDBBQAAAAAAFdcQ12r5CWhOwAAADsAAAALAAAAY2Fub3B5Lmpzb257ImlkIjoiZGVtbyIsIm5hbWUiOiJEZW1vIiwidmVyc2lvbiI6IjEiLCJjYXBhYmlsaXRpZXMiOltdfVBLAwQUAAAAAABXXENdjyikHwQAAAAEAAAACAAAAGluZGV4Lmpzc2FmZVBLAwQUAAAAAABXXENdUjH7jQQAAAAEAAAACAAAAGluZGV4LmpzZXZpbFBLAQIUAxQAAAAAAFdcQ12r5CWhOwAAADsAAAALAAAAAAAAAAAAAACAAQAAAABjYW5vcHkuanNvblBLAQIUAxQAAAAAAFdcQ12PKKQfBAAAAAQAAAAIAAAAAAAAAAAAAACAAWQAAABpbmRleC5qc1BLAQIUAxQAAAAAAFdcQ11SMfuNBAAAAAQAAAAIAAAAAAAAAAAAAACAAY4AAABpbmRleC5qc1BLBQYAAAAAAwADAKUAAAC4AAAAAAA='])('refuses duplicate literal manifest or module entries', encoded => {
  const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
  expect(() => resolveZipBytes(bytes, source)).toThrow('duplicate entry');
});
it.each(['constructor', '__proto__', 'toString'])('reports a deliberate missing-entry error for inherited keys: %s', entry => {
  expect(() => resolveZipBytes(zip({ 'canopy.json': manifest(entry) }), source)).toThrow(`zip missing entry "${entry}"`);
});
