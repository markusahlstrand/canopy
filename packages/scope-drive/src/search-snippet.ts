/** Bound per-hit materialization; the complete extraction remains in the search index. */
export const SNIPPET_SCAN_LIMIT = 65_536;

/** Plain text around the earliest query token. No found token means no claimed context. */
export function searchSnippet(text: string, term: string, width = 240): string | null {
  const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const tokens = term.split(/[^\p{L}\p{N}_]+/u).filter(Boolean).map(fold);
  // Folding diacritics changes offsets; retain a map back to the original characters.
  let folded = '';
  const offsets: number[] = [];
  let offset = 0;
  for (const character of text) {
    const normalized = fold(character);
    for (let i = 0; i < normalized.length; i++) offsets.push(offset);
    folded += normalized;
    offset += character.length;
  }
  const matches = tokens.map(token => folded.indexOf(token)).filter(at => at >= 0);
  if (!matches.length) return null;
  const at = offsets[Math.min(...matches)]!;
  const start = Math.max(0, at - Math.floor(width / 4));
  const end = Math.min(text.length, start + width);
  return `${start ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
}
