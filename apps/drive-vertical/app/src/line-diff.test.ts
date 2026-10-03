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
