import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { filterMatches, SearchMatchFilter } from './search-match-filter';
import type { SearchHit } from './api';
afterEach(cleanup);
it('filters only returned matches and keeps their server order', () => {
  const hits = [{ id: 'a', via: 'name' }, { id: 'b', via: 'content' }, { id: 'c', via: 'metadata' }, { id: 'd', via: 'content' }] as SearchHit[];
  expect(filterMatches(hits, 'all')).toBe(hits); expect(filterMatches(hits, 'content').map(hit => hit.id)).toEqual(['b', 'd']);
  const change = vi.fn(); render(<SearchMatchFilter hits={hits} value="content" onChange={change} />);
  expect(screen.getByRole('status').textContent).toContain('2 of 4 returned matches');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'metadata' } }); expect(change).toHaveBeenCalledExactlyOnceWith('metadata');
});
