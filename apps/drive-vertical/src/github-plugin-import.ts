import { resolvePlugin } from '@canopy/plugin-sources';

const MAX_SOURCE_BYTES = 256_000;

/** Resolve a public GitHub plugin to a pinned commit and a bounded, single entry file. */
export async function importGithubPlugin(ref: { repo: string; ref?: string; path?: string }, fetchEntry: typeof fetch, githubToken?: string) {
  const resolved = await resolvePlugin({ type: 'github', ...ref }, { githubToken });
  if (!('url' in resolved.entry)) throw new Error('GitHub plugin has no JavaScript entry.');
  const response = await fetchEntry(resolved.entry.url);
  if (!response.ok) throw new Error(`Could not fetch plugin entry (${response.status}).`);
  if (Number(response.headers.get('content-length')) > MAX_SOURCE_BYTES) throw new Error('Plugin source is too large.');
  if (!response.body) throw new Error('Plugin entry has no body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SOURCE_BYTES) throw new Error('Plugin source is too large.');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(joined);
  if (!source.trim()) throw new Error('Plugin entry is empty.');
  return { manifest: resolved.manifest, source, provenance: {
    kind: 'github' as const,
    ref: `${ref.repo}${ref.path ? `/${ref.path}` : ''}@${ref.ref || 'main'}`,
    resolved: resolved.version,
  } };
}
