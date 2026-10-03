import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { DriveScreen } from './drive';
vi.mock('./live-updates', () => ({ watchDriveChanges: () => () => {} }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each([false, true])('guards only a draft on a file included in the batch (%s)', async included => {
  const files = ['a', 'b'].map(id => ({ id, folder_id: 'root', name: `${id}.txt`, current_version_id: 'v', created_at: '', updated_at: '', deleted_at: null }));
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => new Response(JSON.stringify(url === '/api/folders/root/files' ? files : url === '/api/files/a' && init?.method !== 'DELETE' ? { file: files[0], version: { id: 'v', source: 'blob', mime: 'text/plain' }, canWrite: true } : url.endsWith('/access') ? { canManage: false } : [])));
  // Text bytes are read separately from JSON metadata.
  const wrapped = vi.fn(async (url: string, init?: RequestInit) => url.includes('/content') ? new Response('original') : fetcher(url, init));
  vi.stubGlobal('fetch', wrapped); const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<DriveScreen auth={{ user: {} }} onError={() => {}} onSignIn={() => {}} onSignOut={() => {}} />);
  fireEvent.doubleClick(await screen.findByText('a.txt'));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit text' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'File text' }), { target: { value: 'draft' } });
  fireEvent.click(within(screen.getByRole('row', { name: new RegExp(included ? 'a.txt' : 'b.txt') })).getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Move 1 selected file to Trash' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm move to Trash' }));
  if (included) {
    expect(confirm).toHaveBeenCalledOnce(); expect(fetcher.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    expect(screen.getByDisplayValue('draft')).toBeTruthy(); confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move to Trash' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'File text' })).toBeNull());
  } else { expect(confirm).not.toHaveBeenCalled(); expect(screen.getByDisplayValue('draft')).toBeTruthy(); }
  await waitFor(() => expect(fetcher.mock.calls.some(([url, init]) => url === `/api/files/${included ? 'a' : 'b'}` && init?.method === 'DELETE')).toBe(true));
});
