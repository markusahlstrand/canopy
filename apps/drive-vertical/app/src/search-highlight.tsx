/** Plain React children: extracted text and file names never become HTML. */
export function SearchHighlight({ text, query, mode }: { text: string; query: string; mode: 'prefix' | 'substring' }) {
  const tokens = [...new Set(query.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(mode === 'prefix' ? /[^\p{L}\p{N}]+/u : /[^\p{L}\p{N}_]+/u).filter(token => token.length >= (mode === 'substring' ? 3 : 1)))];
  let folded = '';
  const offsets: number[] = [];
  let offset = 0;
  for (const char of text) {
    const value = char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (let i = 0; i < value.length; i++) offsets.push(offset);
    folded += value;
    offset += char.length;
  }
  const ranges: [number, number][] = [];
  for (const token of tokens) {
    let from = 0;
    while (from < folded.length) {
      const index = folded.indexOf(token, from);
      if (index < 0) break;
      from = index + token.length;
      if (mode === 'prefix') {
        const before = [...folded.slice(0, index)].at(-1) ?? '';
        const after = [...folded.slice(index + token.length)][0] ?? '';
        if (/[\p{L}\p{N}]/u.test(before) || (token.length === 1 && /[\p{L}\p{N}]/u.test(after))) continue;
      }
      const start = offsets[index]!;
      const final = offsets[index + token.length - 1]!;
      const end = final + (text.codePointAt(final)! > 0xffff ? 2 : 1);
      ranges.push([start, end]);
      from = index + token.length;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  const parts = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    parts.push(text.slice(cursor, start), <mark key={start} className="rounded bg-yellow-200 text-inherit dark:bg-yellow-900">{text.slice(start, end)}</mark>);
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}
