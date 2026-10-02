import { expect, it } from 'vitest';
import { searchSnippet } from '../src/search-snippet.js';
it('centres on a token when query words are separated or punctuated', () => {
  const text = 'x'.repeat(400) + 'budget figures go here ' + 'y'.repeat(400) + '2026';
  expect(searchSnippet(text, 'budget 2026')).toContain('budget');
  expect(searchSnippet('x'.repeat(400) + 'Q3 annual report', 'Q3-report')).toContain('Q3');
});
it('folds diacritics while keeping offsets into the original text', () => {
  expect(searchSnippet('é'.repeat(400) + ' café costs', 'cafe')).toContain('café');
  expect(searchSnippet('e\u0301'.repeat(400) + ' café costs', 'cafe')).toContain('café');
});
it('returns no snippet for unmatched or empty token queries', () => {
  expect(searchSnippet('unrelated text', 'budget')).toBeNull();
  expect(searchSnippet('unrelated text', '--')).toBeNull();
});
