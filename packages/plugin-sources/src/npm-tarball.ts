import type { PluginManifest } from '@canopy/core';
import { init, parse } from 'es-module-lexer';

const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_INFLATED_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES = 256_000;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

const plainPath = (path: string) => path.length > 0 && !path.includes('\\') && !path.includes('\0') &&
  !path.split('/').some(segment => !segment || segment === '.' || segment === '..') && !/^[a-zA-Z]:/.test(path);

async function boundedBytes(response: Response, limit: number, label: string): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`Could not fetch ${label} (${response.status}).`);
  if (Number(response.headers.get('content-length')) > limit) throw new Error(`${label} is too large.`);
  if (!response.body) throw new Error(`${label} has no body.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error(`${label} is too large.`); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function tarFiles(bytes: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start: number, length: number) => decoder.decode(header.subarray(start, start + length)).split('\0')[0]!;
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    const sizeText = field(124, 12).trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error('npm archive has an invalid entry size.');
    const size = Number.parseInt(sizeText, 8);
    const dataStart = offset + 512;
    if (!Number.isSafeInteger(size) || dataStart + size > bytes.length) throw new Error('npm archive is truncated.');
    const type = header[156];
    if (type === 0 || type === 48) {
      if (!plainPath(name) || files.has(name)) throw new Error('npm archive has an unsafe or duplicate path.');
      files.set(name, bytes.subarray(dataStart, dataStart + size));
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Read only a verified, bounded npm archive and return its self-contained plugin entry. */
export async function readNpmTarball(url: string, integrity: string, fetcher: typeof fetch): Promise<{ manifest: PluginManifest; source: string }> {
  const tarball = new URL(url);
  if (tarball.origin !== 'https://registry.npmjs.org' || tarball.username || tarball.password || tarball.search || tarball.hash) {
    throw new Error('npm tarball must be hosted by registry.npmjs.org.');
  }
  const expected = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity)?.[1];
  if (!expected) throw new Error('npm release has no SHA-512 integrity value.');
  const archive = await boundedBytes(await fetcher(url, { redirect: 'manual' }), MAX_ARCHIVE_BYTES, 'npm archive');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', archive.slice().buffer));
  const actual = btoa(String.fromCharCode(...digest));
  if (actual !== expected) throw new Error('npm archive integrity does not match the registry.');
  const inflatedStream = new Response(archive.slice().buffer).body!.pipeThrough(new DecompressionStream('gzip'));
  const inflated = await boundedBytes(new Response(inflatedStream), MAX_INFLATED_BYTES, 'npm archive contents');
  const files = tarFiles(inflated);
  const packageJson = files.get('package/package.json');
  if (!packageJson || packageJson.length > 128 * 1024) throw new Error('npm archive has no bounded package.json.');
  const pkg = JSON.parse(decoder.decode(packageJson)) as { canopy?: PluginManifest };
  if (!pkg.canopy) throw new Error('npm package has no canopy manifest.');
  const entry = pkg.canopy.entry ?? 'index.js';
  if (typeof entry !== 'string' || !plainPath(entry)) throw new Error('npm plugin entry must be a plain relative path.');
  const code = files.get(`package/${entry}`);
  if (!code || code.length > MAX_SOURCE_BYTES) throw new Error('npm plugin entry is missing or too large.');
  const source = decoder.decode(code);
  if (!source.trim()) throw new Error('npm plugin entry is empty.');
  await init;
  if (parse(source)[0].some(specifier => specifier.d !== -2)) throw new Error('npm plugin entry must be a self-contained ES module without imports.');
  return { manifest: pkg.canopy, source };
}
