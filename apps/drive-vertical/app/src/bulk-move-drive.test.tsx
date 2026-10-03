import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DriveScreen } from './drive';
import { selectSite } from './api';
vi.mock('./live-updates', () => ({ watchDriveChanges: () => () => {} }));
afterEach(() => { cleanup(); selectSite(null); vi.unstubAllGlobals(); });
it('moves selected files through the folder picker and retains selected folders', async () => {
  const file = { id: 'f', folder_id: 'root', name: 'notes.txt', current_version_id: null, created_at: '', updated_at: '', deleted_at: null };
  const folders = [{ id: 'keep', name: 'Selected folder', path: 'Selected folder', parent_id: 'root' }, { id: 'dest', name: 'Destination', path: 'Destination', parent_id: 'root' }];
  let moved = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { moved = true; return new Response(JSON.stringify(file)); }
    return new Response(JSON.stringify(url === '/api/folders/root/folders' ? folders : url === '/api/folders/root/files' ? (moved ? [] : [file]) : url.endsWith('/access') ? { canManage: false } : []));
  }); vi.stubGlobal('fetch', fetcher);
  render(<DriveScreen auth={{ user: {} }} onError={() => {}} onSignIn={() => {}} onSignOut={() => {}} />);
  await screen.findByText('notes.txt'); fireEvent.click(screen.getByText('Selected folder')); fireEvent.click(screen.getByText('notes.txt'), { ctrlKey: true });
  fireEvent.click(screen.getByRole('button', { name: 'Move selected files…' }));
  expect(screen.getByLabelText('Files remaining to move').textContent).toBe('notes.txt');
  fireEvent.click(await screen.findByRole('button', { name: 'Destination' }));
  await screen.findByText('No subfolders'); fireEvent.click(screen.getByRole('button', { name: 'Move here' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes).toHaveLength(1); expect(writes[0]![0]).toBe('/api/files/f/move'); expect(JSON.parse(writes[0]![1]!.body as string)).toEqual({ folderId: 'dest' });
  expect(within(screen.getByText('Selected folder').closest('tr')!).getByRole('checkbox').getAttribute('aria-checked')).toBe('true');
});
