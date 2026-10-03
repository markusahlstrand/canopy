import { useMemo } from 'react';
/** Statistics describe the displayed string, including its whitespace, never the unseen file. */
export function textStatistics(text: string) {
  const characters = text.length;
  let words: number | null = text.length <= 20_000 ? 0 : null, lines = text ? 1 : 0;
  for (const _newline of text.matchAll(/\r\n|\r|\n/g)) lines++;
  if (/[\r\n]$/.test(text)) lines--;
  if (words !== null && typeof Intl.Segmenter === 'function') {
    for (const segment of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)) if (segment.isWordLike) words++;
  } else if (words !== null) {
    for (const _word of text.matchAll(/\S+/gu)) words++;
  }
  return { characters, words, lines };
}
export function TextStatistics({ text, truncated = false }: { text: string; truncated?: boolean }) {
  const counts = useMemo(() => textStatistics(text), [text]);
  return <p className="text-xs text-muted-foreground">{truncated ? 'Partial preview counts (the file is longer):' : 'Displayed text:'} {counts.lines.toLocaleString()} lines · {counts.words === null ? 'Word count omitted for large previews' : `${counts.words.toLocaleString()} words (estimate)`} · {counts.characters.toLocaleString()} characters, including whitespace. Counts cover the displayed preview; characters count UTF-16 units, matching the editor and preview limit.</p>;
}
