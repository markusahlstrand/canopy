export const normalizeComparisonText = (text: string) => text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
export interface DiffLine { kind: 'same' | 'removed' | 'added'; text: string; oldLine: number | null; newLine: number | null }
/** Bound alignment work independently of input length; large changes become an explicit block. */
export function lineDiff(before: string, after: string) {
  const a = normalizeComparisonText(before).split('\n'), b = normalizeComparisonText(after).split('\n');
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const left = a.slice(prefix, a.length - suffix), right = b.slice(prefix, b.length - suffix);
  const limited = (left.length + 1) * (right.length + 1) > 250_000;
  const rows: DiffLine[] = []; let oldLine = prefix + 1, newLine = prefix + 1;
  const push = (kind: DiffLine['kind'], text: string) => rows.push({ kind, text, oldLine: kind === 'added' ? null : oldLine++, newLine: kind === 'removed' ? null : newLine++ });
  if (limited) { left.slice(0, 200).forEach(text => push('removed', text)); newLine = prefix + 1; right.slice(0, 200).forEach(text => push('added', text)); }
  else {
    // Intern lines so long strings aren't repeatedly compared in the quadratic loop.
    const ids = new Map<string, number>(); const id = (line: string) => { if (!ids.has(line)) ids.set(line, ids.size); return ids.get(line)!; };
    const x = left.map(id), y = right.map(id), width = y.length + 1;
    const lengths = new Uint16Array((x.length + 1) * width);
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lengths[i * width + j] = x[i] === y[j] ? 1 + lengths[(i + 1) * width + j + 1]! : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
    let i = 0, j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { push('same', left[i++]!); j++; }
      else if (i < x.length && (j === y.length || lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!)) push('removed', left[i++]!);
      else push('added', right[j++]!);
    }
  }
  return { rows: rows.slice(0, 400), limited: limited || rows.length > 400, prefix, suffix };
}
