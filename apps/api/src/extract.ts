import { drainToBytes, isPdf, pdfText } from "@canopy/docworker";
import type { DocumentTextExtractor } from "@canopy/store";

/**
 * Skip files larger than this. A PDF must be read whole to parse (its cross-ref
 * table lives at the end), so we can't stream a prefix — and we don't want a
 * giant upload to stall an index write.
 */
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

/** Cap on the text the *indexer* keeps — matches the store's body cap. */
const MAX_OUTPUT_CHARS = 512 * 1024;

/**
 * The search indexer's text extractor: turns a PDF's embedded text layer into
 * plain text for the FTS index, capped at {@link MAX_OUTPUT_CHARS}. Parsing is
 * delegated to {@link https://github.com/ | @canopy/docworker}'s in-process
 * parser — the *same* implementation the MCP read tools use through the injected
 * `DocWorker` adapter, so there's one PDF code path across indexing, local Node,
 * and the (optional) container backend.
 *
 * This cap is only the index body size: the MCP `fetch`/`get_outline` tools read
 * the uncapped, *ranged* layer through the adapter so they can page the whole
 * document and report truncation explicitly.
 */
export const documentTextExtractor: DocumentTextExtractor = {
  supports: isPdf,
  async extract(stream, name, mime) {
    if (!isPdf(name, mime)) return undefined;
    const { bytes } = await drainToBytes(stream, MAX_INPUT_BYTES);
    if (!bytes) return undefined; // empty, unreadable, or too big to parse
    const r = await pdfText(bytes, name, mime, { limit: MAX_OUTPUT_CHARS });
    return r?.text || undefined;
  },
};
