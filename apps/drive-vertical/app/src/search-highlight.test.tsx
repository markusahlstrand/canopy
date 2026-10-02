import { afterEach, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { SearchHighlight } from './search-highlight';
afterEach(cleanup);
it('highlights nonadjacent, punctuated and accent-folded query tokens', () => {
  const { container } = render(<SearchHighlight text="Café Q3 report, budget elsewhere in 2026" query="cafe Q3-report budget 2026" />);
  expect([...container.querySelectorAll('mark')].map(node => node.textContent)).toEqual(['Café', 'Q3', 'report', 'budget', '2026']);
  expect(container.textContent).toBe('Café Q3 report, budget elsewhere in 2026');
});
it('merges overlapping tokens and renders HTML-looking text literally', () => {
  const { container } = render(<SearchHighlight text="<script>alert(1)</script> budget" query="bud budget script" />);
  expect(container.querySelector('script')).toBeNull();
  expect(container.textContent).toBe('<script>alert(1)</script> budget');
  expect([...container.querySelectorAll('mark')].map(node => node.textContent)).toEqual(['script', 'script', 'budget']);
});
it('leaves unmatched text and supplementary Unicode characters intact', () => {
  const { container } = render(<SearchHighlight text="📂 𐐀 notes" query="𐐀 missing" />);
  expect(container.textContent).toBe('📂 𐐀 notes');
  expect(container.querySelector('mark')?.textContent).toBe('𐐀');
});
