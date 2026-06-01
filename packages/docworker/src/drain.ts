/**
 * Read a stream fully into one buffer, bounded by `cap`. Returns `bytes: null`
 * with `truncated: true` if the stream holds more than `cap` — a document that
 * big can't be parsed from a prefix (a PDF's cross-ref table is at the end), so
 * the caller surfaces it as truncated rather than silently parsing nothing.
 */
export async function drainToBytes(
  stream: ReadableStream<Uint8Array>,
  cap: number,
): Promise<{ bytes: Uint8Array | null; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > cap) return { bytes: null, truncated: true };
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    out.set(ch, off);
    off += ch.byteLength;
  }
  return { bytes: out, truncated: false };
}
