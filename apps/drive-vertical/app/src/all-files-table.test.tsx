import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AllFilesTable, fileTags, type AllFilesRow } from './all-files-table';

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

it('turns each folder on the path into a tag beside the labels, once each', () => {
  expect(fileTags({ category: 'Fiscal/Modelo 303', labels: ['tax', 'Fiscal'] })).toEqual(['Fiscal', 'Modelo 303', 'tax']);
  expect(fileTags({ category: '', labels: [] })).toEqual([]);
});

it('keeps only the files that carry every picked tag, and clears the pick', () => {
  const files: AllFilesRow[] = [
    { ...row, id: 'a', name: 'modelo.pdf', category: 'Fiscal/Modelo 303', labels: ['2024'] },
    { ...row, id: 'b', name: 'iva.pdf', category: 'Fiscal/IVA', labels: ['2024'] },
    { ...row, id: 'c', name: 'deed.pdf', category: 'Houses', labels: [] },
  ];
  render(<AllFilesTable files={files} below={null} sort={sort} onSort={() => {}} onOpen={() => {}} loading={false} />);
  const bar = within(screen.getByRole('group', { name: 'Filter by tag' }));
  // Counts, most-used first.
  expect(bar.getAllByRole('button').map(b => b.textContent)).toEqual(['20242', 'Fiscal2', 'Houses1', 'IVA1', 'Modelo 3031']);
  fireEvent.click(bar.getByRole('button', { name: /^Fiscal/ }));
  expect(screen.queryByText('deed.pdf')).toBeNull();
  expect(screen.getByText('iva.pdf')).toBeTruthy();
  fireEvent.click(bar.getByRole('button', { name: /^Modelo 303/ }));
  expect(screen.queryByText('iva.pdf')).toBeNull();
  expect(screen.getByText('modelo.pdf')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Clear tags' }));
  expect(screen.getByText('deed.pdf')).toBeTruthy();
});

it('says when no loaded file has the picked tags, and that more may', () => {
  const files: AllFilesRow[] = [{ ...row, id: 'a', category: 'A', labels: [] }, { ...row, id: 'b', name: 'b.pdf', category: 'B', labels: [] }];
  render(<AllFilesTable files={files} below={null} sort={sort} onSort={() => {}} onOpen={() => {}} loading={false} more />);
  const bar = within(screen.getByRole('group', { name: 'Filter by tag' }));
  fireEvent.click(bar.getByRole('button', { name: /^A/ }));
  fireEvent.click(bar.getByRole('button', { name: /^B/ }));
  expect(screen.getByRole('status').textContent).toContain('Load more');
});

it('drops a picked tag once no loaded file carries it, rather than hiding every row', () => {
  const first: AllFilesRow[] = [{ ...row, id: 'a', name: 'a.pdf', category: 'A', labels: [] }, { ...row, id: 'b', name: 'b.pdf', category: 'B', labels: [] }];
  const props = { below: null, sort, onSort: () => {}, onOpen: () => {}, loading: false };
  const view = render(<AllFilesTable files={first} {...props} />);
  fireEvent.click(within(screen.getByRole('group', { name: 'Filter by tag' })).getByRole('button', { name: /^A/ }));
  expect(screen.queryByText('b.pdf')).toBeNull();
  view.rerender(<AllFilesTable files={[first[1]!]} {...props} />);
  expect(screen.getByText('b.pdf')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Clear tags' })).toBeNull();
});

it('names a row tag by what it does', () => {
  render(<AllFilesTable files={[{ ...row, id: 'a', category: 'Fiscal', labels: [] }]} below={null} sort={sort} onSort={() => {}} onOpen={() => {}} loading={false} />);
  expect(screen.getAllByRole('button', { name: 'Filter by tag Fiscal' }).length).toBeGreaterThan(0);
});
