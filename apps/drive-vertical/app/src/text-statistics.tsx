import { useMemo } from 'react';
/** Statistics describe the displayed string, including its whitespace, never the unseen file. */
export function textStatistics(text: string) {
  let characters = 0, words = 0, lines = text ? 1 : 0;
  for (const _character of text) characters++;
  for (const _newline of text.matchAll(/\r\n|\r|\n/g)) lines++;
  if (typeof Intl.Segmenter === 'function') {
    for (const segment of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)) if (segment.isWordLike) words++;
  } else {
    for (const _word of text.matchAll(/\S+/gu)) words++;
  }
  return { characters, words, lines };
}
export function TextStatistics({ text }: { text: string }) {
  const counts = useMemo(() => textStatistics(text), [text]);
  return <p aria-label="Displayed text statistics" className="text-xs text-muted-foreground">Displayed text: {counts.lines.toLocaleString()} lines · {counts.words.toLocaleString()} words (estimate) · {counts.characters.toLocaleString()} characters, including whitespace. Counts cover the displayed preview; characters count Unicode code points.</p>;
}
