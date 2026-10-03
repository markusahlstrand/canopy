import { expect, it } from 'vitest';
import { lineDiff, normalizeComparisonText } from './line-diff';
it('aligns insertions/deletions with version line numbers and preserves literal content', () => {
  expect(lineDiff('', 'x').rows).toEqual([{ kind: 'added', text: 'x', oldLine: null, newLine: 1 }]);
  expect(lineDiff('x', '').rows).toEqual([{ kind: 'removed', text: 'x', oldLine: 1, newLine: null }]);
  expect(lineDiff('a\nb\nc', 'a\nx\nb\nc').rows).toEqual([{ kind: 'added', text: 'x', oldLine: null, newLine: 2 }]);
  const rows = lineDiff('<script>\nold\nsame\nend', '<script>\nnew\nsame\nlast').rows;
  expect(rows.map(row => row.kind)).toEqual(['removed', 'added', 'same', 'removed', 'added']);
  expect(rows[2]).toMatchObject({ oldLine: 3, newLine: 3 });
  expect(normalizeComparisonText('a\r\nb\r\n')).toBe('a\nb');
});
it('bounds expensive alignment and rendered rows for large changing files', () => {
  const diff = lineDiff('old\n'.repeat(10000), 'new\n'.repeat(10000));
  expect(diff.limited).toBe(true); expect(diff.rows.length).toBeLessThanOrEqual(400);
});
it('aligns distant edits without labelling unchanged lines as changes', () => {
  const old = Array.from({ length: 20000 }, (_, i) => `line ${i + 1}`);
  const next = [...old]; next[5] = 'X'; next[19990] = 'Y';
  const result = lineDiff(old.join('\n'), next.join('\n'));
  expect(result.limited).toBe(false);
  expect(result.rows.filter(row => row.kind === 'removed').map(row => row.text)).toEqual(['line 6', 'line 19991']);
  expect(result.rows.filter(row => row.kind === 'added').map(row => row.text)).toEqual(['X', 'Y']);
  expect(result.rows.some(row => row.kind === 'omitted')).toBe(true);
  expect(result.rows.length).toBeLessThan(20);
});
it('does not display a misleading partial replacement when alignment exceeds the cutoff', () => {
  const result = lineDiff('old\n'.repeat(499), 'new\n'.repeat(499));
  expect(result.unavailable).toBe(true); expect(result.rows).toEqual([]);
});
it('keeps insertions and deletions aligned across repeated lines', () => {
  const result = lineDiff('a\nb\na\nc', 'a\na\nx\nc');
  expect(result.rows.filter(row => row.kind === 'removed').map(row => row.text)).toEqual(['b']);
  expect(result.rows.filter(row => row.kind === 'added').map(row => row.text)).toEqual(['x']);
});
