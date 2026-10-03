import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MoveDialog } from './move-dialog';
import * as api from './api';
afterEach(() => { cleanup(); api.selectSite(null); vi.restoreAllMocks(); });
const items = ['a', 'b'].map(id => ({ id, name: id, kind: 'doc' as const, modified: '', size: '', isFolder: false }));
it('pins the destination space and retries only the remaining files after a partial refusal', async () => {
  api.selectSite('original'); vi.spyOn(api, 'listFoldersPage').mockResolvedValue({ entries: [], next: null });
  const move = vi.spyOn(api, 'moveFile').mockResolvedValueOnce({} as api.DriveFile).mockRejectedValueOnce(new api.ApiError(403, 'Denied')).mockResolvedValue({} as api.DriveFile);
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
