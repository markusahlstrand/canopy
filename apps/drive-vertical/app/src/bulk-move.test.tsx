import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MoveDialog } from './move-dialog';
import * as api from './api';
afterEach(() => { cleanup(); api.selectSite(null); vi.restoreAllMocks(); });
const items = ['a', 'b'].map(id => ({ id, name: id, kind: 'doc' as const, modified: '', size: '', isFolder: false }));
it('pins the destination space and retries only transient failures', async () => {
  api.selectSite('original'); vi.spyOn(api, 'listFoldersPage').mockResolvedValue({ entries: [], next: null });
  const move = vi.spyOn(api, 'moveFile').mockResolvedValueOnce({} as api.DriveFile).mockRejectedValueOnce(new api.ApiError(503, 'Unavailable')).mockResolvedValue({} as api.DriveFile);
  const onMoved = vi.fn(async (_ids: string[]) => {}), close = vi.fn();
  render(<MoveDialog items={items} sourceFolderId="source" onClose={close} onMoved={onMoved} />);
  await screen.findByText('No subfolders'); api.selectSite('other'); fireEvent.click(screen.getByRole('button', { name: 'Move here' }));
  await screen.findByRole('alert'); expect(onMoved).toHaveBeenCalledExactlyOnceWith(['a']); expect(close).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Files remaining to move').textContent).toBe('b');
  fireEvent.click(screen.getByRole('button', { name: 'Move here' })); await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(move.mock.calls).toEqual([['a', 'root', 'original'], ['b', 'root', 'original'], ['b', 'root', 'original']]);
});
it('prevents duplicate submissions and stops remaining mutations after unmount', async () => {
  vi.spyOn(api, 'listFoldersPage').mockResolvedValue({ entries: [], next: null }); let finish!: () => void;
  const move = vi.spyOn(api, 'moveFile').mockImplementation(() => new Promise(resolve => { finish = () => resolve({} as api.DriveFile); }));
  const changed = vi.fn(async () => {}); const view = render(<MoveDialog items={items} sourceFolderId="source" onClose={() => {}} onMoved={changed} />);
  await screen.findByText('No subfolders'); const button = screen.getByRole('button', { name: 'Move here' }); fireEvent.click(button); fireEvent.click(button);
  view.unmount(); await act(async () => finish()); expect(move).toHaveBeenCalledOnce(); expect(changed).not.toHaveBeenCalled();
});

it('continues past a middle collision, reports it, and does not retry it in the same folder', async () => {
  vi.spyOn(api, 'listFoldersPage').mockResolvedValue({ entries: [], next: null });
  const move = vi.spyOn(api, 'moveFile').mockResolvedValueOnce({} as api.DriveFile).mockRejectedValueOnce(new api.ApiError(409, 'Conflict')).mockResolvedValue({} as api.DriveFile);
  const changed = vi.fn(async () => {}); const close = vi.fn();
  render(<MoveDialog items={[...items, { ...items[0]!, id: 'c', name: 'c' }]} sourceFolderId="source" onClose={close} onMoved={changed} />);
  await screen.findByText('No subfolders'); fireEvent.click(screen.getByRole('button', { name: 'Move here' }));
  await screen.findByRole('alert'); expect(move.mock.calls.map(call => call[0])).toEqual(['a', 'b', 'c']);
  expect(changed).toHaveBeenCalledWith(['a', 'c']); expect(screen.getByLabelText('Files not moved').textContent).toContain('b: name collision');
  expect(screen.getByRole('button', { name: 'Move here' }).hasAttribute('disabled')).toBe(true); expect(close).not.toHaveBeenCalled();
});
it('cancels only the remaining moves after an in-flight move completes', async () => {
  vi.spyOn(api, 'listFoldersPage').mockResolvedValue({ entries: [], next: null }); let finish!: () => void;
  const move = vi.spyOn(api, 'moveFile').mockImplementation(() => new Promise(resolve => { finish = () => resolve({} as api.DriveFile); }));
  render(<MoveDialog items={items} sourceFolderId="source" onClose={() => {}} onMoved={async () => {}} />);
  await screen.findByText('No subfolders'); fireEvent.click(screen.getByRole('button', { name: 'Move here' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel remaining moves' })); await act(async () => finish());
  expect(move).toHaveBeenCalledOnce(); expect(screen.getByRole('alert').textContent).toContain('1 not attempted');
});

it('lets a refused file be tried in a different destination without replaying successes', async () => {
  vi.spyOn(api, 'listFoldersPage').mockResolvedValue({ entries: [{ id: 'dest', parent_id: 'root', name: 'Destination', path: 'Destination' }], next: null });
  const move = vi.spyOn(api, 'moveFile').mockRejectedValueOnce(new api.ApiError(403, 'Denied')).mockResolvedValue({} as api.DriveFile);
  const close = vi.fn(); render(<MoveDialog items={items} sourceFolderId="source" onClose={close} onMoved={async () => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Destination' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Move here' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Move here' })); await screen.findByRole('alert');
  expect(screen.getByLabelText('Files not moved').textContent).toContain('No permission to move a into Destination');
  fireEvent.click(screen.getByRole('button', { name: 'My Drive' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Move here' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Move here' })); await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(move.mock.calls.map(call => call.slice(0, 2))).toEqual([['a', 'dest'], ['b', 'dest'], ['a', 'root']]);
});
