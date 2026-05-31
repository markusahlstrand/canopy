import { extractText, getDocumentProxy } from "unpdf";
import type { DocumentTextExtractor } from "@canopy/store";

/**
 * Skip files larger than this. A PDF must be read whole to parse (its cross-ref
 * table lives at the end), so we can't stream a prefix — and we don't want a
 * giant upload to stall an index write.
 */
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

/** Cap on the text we return — matches the indexer's body cap. */
const MAX_OUTPUT_CHARS = 512 * 1024;

function isPdf(name: string, mime?: string | null): boolean {
  return (mime?.toLowerCase().includes("pdf") ?? false) || /\.pdf$/i.test(name);
}

/** Read a stream fully into one buffer, or null if it exceeds `cap` (too big to parse). */
async function drain(stream: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > cap) return null;
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
  return out;
}

/**
 * Extracts a PDF's embedded text layer so PDFs become full-text searchable and
 * readable through the MCP `fetch` tool — closing the gap where Canopy treated
 * every PDF as opaque bytes.
 *
 * This reads the *text layer*, not OCR: digitally-generated PDFs (the common
 * case) carry selectable text and extract cleanly; scanned/image-only PDFs have
 * no text layer and yield undefined here. Uses `unpdf` (a serverless pdf.js
 * build) so it runs unchanged on both Node and Cloudflare Workers.
 */
export const documentTextExtractor: DocumentTextExtractor = {
  supports: isPdf,
  async extract(stream, name, mime) {
    if (!isPdf(name, mime)) return undefined;
    try {
      const bytes = await drain(stream, MAX_INPUT_BYTES);
      if (!bytes || bytes.byteLength === 0) return undefined;
      const pdf = await getDocumentProxy(bytes);
      const { text } = await extractText(pdf, { mergePages: true });
      const raw = text as string | string[];
      const merged = (Array.isArray(raw) ? raw.join("\n") : raw).trim();
      return merged ? merged.slice(0, MAX_OUTPUT_CHARS) : undefined;
    } catch (err) {
      console.warn(`[extract] pdf text extraction failed for "${name}": ${(err as Error).message}`);
      return undefined;
    }
  },
};
