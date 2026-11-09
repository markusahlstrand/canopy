import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AllFilesTable, type AllFilesRow } from './all-files-table';

afterEach(cleanup);
const row: AllFilesRow = { id: 'f1', name: 'a.pdf', kind: 'pdf', modified: 'today', size: '—', isFolder: false, category: 'Fiscal', labels: [] };
const sort = { key: 'name' as const, dir: 'asc' as const };

it('opens a file and sorts from the headers', () => {
  const onOpen = vi.fn(), onSort = vi.fn();
  render(<AllFilesTable files={[row]} below={null} sort={sort} onSort={onSort} onOpen={onOpen} loading={false} />);
  fireEvent.click(screen.getByRole('button', { name: /a\.pdf/ }));
  expect(onOpen).toHaveBeenCalledWith('f1');
  fireEvent.click(screen.getByRole('button', { name: 'Modified' }));
  expect(onSort).toHaveBeenCalledWith('modified');
});

it('says what an empty result means, and that it is loading before it knows', () => {
  const props = { sort, onSort: () => {}, onOpen: () => {} };
  const { rerender } = render(<AllFilesTable {...props} files={[]} below={null} loading />);
  expect(screen.getByRole('status').textContent).toBe('Loading files…');
  rerender(<AllFilesTable {...props} files={[]} below={null} loading={false} />);
  expect(screen.getByRole('status').textContent).toBe('No files in this space yet.');
  rerender(<AllFilesTable {...props} files={[]} below="Fiscal" loading={false} />);
  expect(screen.getByRole('status').textContent).toBe('No files in Fiscal or below it.');
});
