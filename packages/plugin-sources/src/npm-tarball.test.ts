import { expect, it, vi } from 'vitest';
import { gzipSync } from 'fflate';
import { readNpmTarball } from './npm-tarball';

const encoder = new TextEncoder();
function archive(source: string): Uint8Array {
  const entries = new Map([
    ['package/package.json', JSON.stringify({canopy:{id:'sample',name:'Sample',version:'1.0.0',entry:'index.js',capabilities:[],contributes:{detailView:{id:'main',title:'Sample'}}}})],
    ['package/index.js', source],
  ]);
  const blocks: Uint8Array[] = [];
  for (const [name, text] of entries) {
    const data = encoder.encode(text), header = new Uint8Array(512);
    header.set(encoder.encode(name));
    header.set(encoder.encode(data.length.toString(8).padStart(11, '0') + '\0'), 124);
    header[156] = 48;
    header.set(encoder.encode('ustar\0'), 257);
    header.fill(32, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.set(encoder.encode(checksum.toString(8).padStart(6, '0') + '\0 '), 148);
    blocks.push(header, data, new Uint8Array((512 - data.length % 512) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const tar = new Uint8Array(blocks.reduce((size, block) => size + block.length, 0));
  let offset = 0;
  for (const block of blocks) { tar.set(block, offset); offset += block.length; }
  return gzipSync(tar);
}

async function fixture(source: string) {
  const bytes = archive(source);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', bytes.slice().buffer));
  return {integrity:`sha512-${btoa(String.fromCharCode(...digest))}`,
    fetcher:vi.fn(async () => new Response(bytes.slice().buffer))};
}

it('imports the exact entry from an integrity-verified npm archive', async () => {
  const source = 'export default function render(ctx) { ctx.container.textContent = "ok"; }';
  const {integrity, fetcher} = await fixture(source);
  const result = await readNpmTarball('https://registry.npmjs.org/sample/-/sample-1.0.0.tgz', integrity, fetcher);
  expect(result.source).toBe(source);
  expect(result.manifest.id).toBe('sample');
});

it('rejects a changed archive and a module that still imports dependencies', async () => {
  const {fetcher} = await fixture('export { default } from "./dependency.js";');
  await expect(readNpmTarball('https://registry.npmjs.org/sample/-/sample-1.0.0.tgz', 'sha512-bad', fetcher)).rejects.toThrow('integrity');
  const valid = await fixture('export { default } from "./dependency.js";');
  await expect(readNpmTarball('https://registry.npmjs.org/sample/-/sample-1.0.0.tgz', valid.integrity, valid.fetcher)).rejects.toThrow('self-contained');
});

it('rejects non-registry archive URLs before fetching', async () => {
  const fetcher = vi.fn();
  await expect(readNpmTarball('https://example.com/plugin.tgz', 'sha512-test', fetcher)).rejects.toThrow('registry.npmjs.org');
  expect(fetcher).not.toHaveBeenCalled();
});
