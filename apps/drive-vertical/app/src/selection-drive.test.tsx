import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DriveScreen } from './drive';
import { selectSite } from './api';
const live = vi.hoisted(() => ({ changed: () => {} }));
vi.mock('./live-updates', () => ({ watchDriveChanges: (changed: () => void) => { live.changed = changed; return () => {}; } }));
afterEach(() => { cleanup(); selectSite(null); vi.unstubAllGlobals(); });
it('clears selection on folder/search navigation and reports only reachable selections after refresh', async () => {
  const file = { id: 'f', folder_id: 'root', name: 'notes.txt', current_version_id: null, created_at: '', updated_at: '', deleted_at: null };
  let deleted = false;
  vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(
    url === '/api/folders/root/folders' ? [{ id: 'folder', name: 'Folder', path: 'Folder', parent_id: 'root' }] :
    url === '/api/folders/root/files' ? (deleted ? [] : [file]) :
    url.includes('/api/search') ? { hits: [{ ...file, via: 'name' }] } : url.endsWith('/access') ? { canManage: false } : [])));
  render(<DriveScreen auth={{ user: {}, principal: 'selection-test' }} onError={() => {}} onSignIn={() => {}} onSignOut={() => {}} />);
  fireEvent.click(await screen.findByText('notes.txt'));
  const status = screen.getByRole('status', { name: 'Selection status' }); expect(status.textContent).toBe('1 selected');
  deleted = true; act(() => live.changed());
  await waitFor(() => expect(screen.queryByText('notes.txt')).toBeNull());
  expect(screen.getByRole('region', { name: 'Selection' }).textContent).toContain('0 items selected');
  expect(screen.queryByRole('button', { name: 'Move 1 selected file to Trash' })).toBeNull();
  fireEvent.doubleClick(screen.getByText('Folder'));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull());
  expect(screen.getByRole('status', { name: 'Selection status' })).toBe(status); expect(status.textContent).toBe('Selection cleared');
  fireEvent.change(screen.getByPlaceholderText('Search this space'), { target: { value: 'notes' } });
  fireEvent.click(await screen.findByRole('row', { name: /notes/ })); expect(status.textContent).toBe('1 selected');
  fireEvent.change(screen.getByPlaceholderText('Search this space'), { target: { value: 'notes2' } });
  expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull(); expect(status.textContent).toBe('Selection cleared');
});
