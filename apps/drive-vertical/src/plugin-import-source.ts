const MAX_SOURCE_BYTES = 256_000;

/** Fetch one bundled JavaScript entry without buffering an unbounded response in the Worker. */
export async function fetchPluginSource(url: string, fetchEntry: typeof fetch): Promise<string> {
  const response = await fetchEntry(url);
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
      if (bytes > MAX_SOURCE_BYTES) { await reader.cancel(); throw new Error('Plugin source is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(joined);
  if (!source.trim()) throw new Error('Plugin entry is empty.');
  return source;
}
