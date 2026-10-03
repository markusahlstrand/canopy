export const normalizeComparisonText = (text: string) => text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
export interface DiffLine { kind: 'same' | 'removed' | 'added' | 'omitted'; text: string; oldLine: number | null; newLine: number | null }
/** Myers alignment bounded by edit distance and work, rather than a quadratic line table. */
export function lineDiff(before: string, after: string) {
  const oldText = normalizeComparisonText(before), newText = normalizeComparisonText(after);
  const a = oldText ? oldText.split('\n') : [], b = newText ? newText.split('\n') : [];
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const left = a.slice(prefix, a.length - suffix), right = b.slice(prefix, b.length - suffix);
  const maxEdits = 256, offset = maxEdits + 1;
  let frontier = new Int32Array(2 * maxEdits + 3).fill(-1); frontier[offset + 1] = 0;
  const trace: Int32Array[] = [];
  let distance = -1, work = 0;
  outer: for (let d = 0; d <= maxEdits; d++) {
    trace.push(frontier.slice());
    for (let k = -d; k <= d; k += 2) {
      if (++work > 1_000_000) break outer;
      const at = offset + k;
      let x = k === -d || (k !== d && frontier[at - 1]! < frontier[at + 1]!) ? frontier[at + 1]! : frontier[at - 1]! + 1;
      let y = x - k;
      while (x < left.length && y < right.length && left[x] === right[y]) {
        if (++work > 1_000_000) break outer;
        x++; y++;
      }
      frontier[at] = x;
      if (x >= left.length && y >= right.length) { distance = d; break outer; }
    }
  }
  if (distance < 0) return { rows: [] as DiffLine[], limited: true, unavailable: true, prefix, suffix };
  const reversed: { kind: 'same' | 'removed' | 'added'; text: string }[] = [];
  let x = left.length, y = right.length;
  for (let d = distance; d >= 0; d--) {
    const v = trace[d]!, k = x - y;
    const previousK = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
    const previousX = d === 0 ? 0 : v[offset + previousK]!, previousY = d === 0 ? 0 : previousX - previousK;
    while (x > previousX && y > previousY) { reversed.push({ kind: 'same', text: left[--x]! }); y--; }
    if (d > 0) {
      if (x === previousX) reversed.push({ kind: 'added', text: right[--y]! });
      else reversed.push({ kind: 'removed', text: left[--x]! });
    }
  }
  let oldLine = prefix + 1, newLine = prefix + 1;
  const aligned: DiffLine[] = reversed.reverse().map(row => ({ ...row, oldLine: row.kind === 'added' ? null : oldLine++, newLine: row.kind === 'removed' ? null : newLine++ }));
  const rows: DiffLine[] = [];
  for (let i = 0; i < aligned.length;) {
    if (aligned[i]!.kind !== 'same') { rows.push(aligned[i++]!); continue; }
    let end = i;
    while (end < aligned.length && aligned[end]!.kind === 'same') end++;
    if (end - i <= 6) rows.push(...aligned.slice(i, end));
    else {
      rows.push(...aligned.slice(i, i + 3));
      rows.push({ kind: 'omitted', text: `${end - i - 6} unchanged lines omitted`, oldLine: null, newLine: null });
      rows.push(...aligned.slice(end - 3, end));
    }
    i = end;
  }
  // Never show a one-sided or incomplete change when the display budget is exceeded.
  if (rows.length > 400) return { rows: [] as DiffLine[], limited: true, unavailable: true, prefix, suffix };
  return { rows, limited: false, unavailable: false, prefix, suffix };
}
