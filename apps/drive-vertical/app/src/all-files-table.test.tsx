import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as api from './api';
import { AllFilesTable, fileTags, type AllFilesRow } from './all-files-table';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
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

const details = (labels: string[], canWrite = true): api.FileDetails => ({ fileId: 'f1', description: 'kept', labels, revision: 7, canWrite });
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

it('adds a tag against the latest details and tells the parent', async () => {
  const read = vi.spyOn(api, 'fileDetails').mockResolvedValue(details(['2024']));
  const update = vi.spyOn(api, 'updateFileDetails').mockResolvedValue(details(['2024', 'paid']));
  const onLabelsChanged = vi.fn();
  render(<AllFilesTable files={[{ ...row, labels: ['2024'] }]} below={null} sort={sort} onSort={() => {}} onOpen={() => {}} loading={false} onLabelsChanged={onLabelsChanged} />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Add tag to a.pdf' })[0]!);
  fireEvent.change(screen.getByLabelText('New tag for a.pdf'), { target: { value: ' paid ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await settle();
  expect(read).toHaveBeenCalledWith('f1');
  expect(update).toHaveBeenCalledWith('f1', 'kept', ['2024', 'paid'], 7);
  expect(onLabelsChanged).toHaveBeenCalledWith('f1', ['2024', 'paid']);
  expect(screen.queryByLabelText('New tag for a.pdf')).toBeNull();
});

it('does not add a label the file already has', async () => {
  vi.spyOn(api, 'fileDetails').mockResolvedValue(details(['paid']));
  const update = vi.spyOn(api, 'updateFileDetails').mockResolvedValue(details(['paid']));
  render(<AllFilesTable files={[row]} below={null} sort={sort} onSort={() => {}} onOpen={() => {}} loading={false} onLabelsChanged={() => {}} />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Add tag to a.pdf' })[0]!);
  fireEvent.change(screen.getByLabelText('New tag for a.pdf'), { target: { value: 'paid' } });
  fireEvent.submit(screen.getByLabelText('New tag for a.pdf'));
  await settle();
  expect(update).toHaveBeenCalledWith('f1', 'kept', ['paid'], 7);
});

it('removes a label, but offers no remove on a folder tag', async () => {
  vi.spyOn(api, 'fileDetails').mockResolvedValue(details(['2024', 'paid']));
  const update = vi.spyOn(api, 'updateFileDetails').mockResolvedValue(details(['2024']));
  const onLabelsChanged = vi.fn();
  render(<AllFilesTable files={[{ ...row, labels: ['2024', 'paid'] }]} below={null} sort={sort} onSort={() => {}} onOpen={() => {}} loading={false} onLabelsChanged={onLabelsChanged} />);
  expect(screen.queryByRole('button', { name: 'Remove tag Fiscal from a.pdf' })).toBeNull();
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove tag paid from a.pdf' })[0]!);
  await settle();
  expect(update).toHaveBeenCalledWith('f1', 'kept', ['2024'], 7);
  expect(onLabelsChanged).toHaveBeenCalledWith('f1', ['2024']);
});

it('says so when the file cannot be changed, and saves nothing', async () => {
  vi.spyOn(api, 'fileDetails').mockResolvedValue(details([], false));
  const update = vi.spyOn(api, 'updateFileDetails');
  render(<AllFilesTable files={[row]} below={null} sort={sort} onSort={() => {}} onOpen={() => {}} loading={false} onLabelsChanged={() => {}} />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Add tag to a.pdf' })[0]!);
  fireEvent.change(screen.getByLabelText('New tag for a.pdf'), { target: { value: 'paid' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await settle();
  expect(update).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toBe("You can't change the tags on a.pdf.");
});

it('asks for a reload when the details changed meanwhile', async () => {
  vi.spyOn(api, 'fileDetails').mockResolvedValue(details([]));
  vi.spyOn(api, 'updateFileDetails').mockRejectedValue(new api.ApiError(409, 'revision mismatch'));
  const onLabelsChanged = vi.fn();
  render(<AllFilesTable files={[row]} below={null} sort={sort} onSort={() => {}} onOpen={() => {}} loading={false} onLabelsChanged={onLabelsChanged} />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Add tag to a.pdf' })[0]!);
  fireEvent.change(screen.getByLabelText('New tag for a.pdf'), { target: { value: 'paid' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await settle();
  expect(screen.getByRole('alert').textContent).toContain('Reload');
  expect(onLabelsChanged).not.toHaveBeenCalled();
});

it('offers no tag editing without a handler', () => {
  render(<AllFilesTable files={[{ ...row, labels: ['paid'] }]} below={null} sort={sort} onSort={() => {}} onOpen={() => {}} loading={false} />);
  expect(screen.queryByRole('button', { name: 'Add tag to a.pdf' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Remove tag paid from a.pdf' })).toBeNull();
});
