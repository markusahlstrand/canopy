import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BulkRestore } from './bulk-restore';
import * as api from './api';
afterEach(() => { cleanup(); api.selectSite(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('continues after a refusal and retains the original space throughout a batch', async () => {
  api.selectSite('space-a');
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    api.selectSite('space-b');
    return new Response(JSON.stringify({ id: url }), { status: url.includes('/bad/') ? 403 : 200 });
  });
  vi.stubGlobal('fetch', fetch);
  const onRestored = vi.fn(async (_ids: string[]) => {});
  render(<BulkRestore files={[{ id: 'first', name: 'First' }, { id: 'bad', name: 'Refused' }, { id: 'last', name: 'Last' }]} disabled={false} onRestored={onRestored} />);
  fireEvent.click(screen.getByRole('button', { name: 'Restore 3 selected files' }));
  await screen.findByText(/No permission to restore 1 file: Refused/);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/files/first/restore', '/api/files/bad/restore', '/api/files/last/restore']);
  for (const [, init] of fetch.mock.calls) expect(init?.headers).toMatchObject({ 'x-site': 'space-a' });
  expect(onRestored).toHaveBeenCalledExactlyOnceWith(['first', 'last']);
});
it('hides the action without a selection and refuses disabled restores', () => {
  const restore = vi.spyOn(api, 'restoreFile');
  const props = { disabled: true, onRestored: async () => {} };
  const view = render(<BulkRestore {...props} files={[]} />);
  expect(screen.queryByRole('button')).toBeNull();
  view.rerender(<BulkRestore {...props} files={[{ id: 'file', name: 'File' }]} />);
  fireEvent.click(screen.getByRole('button'));
  expect(restore).not.toHaveBeenCalled();
});

it('keeps the running batch and its outcome when the Trash controls are hidden', async () => {
  let finish!: () => void;
  const restore = vi.spyOn(api, 'restoreFile').mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({} as api.DriveFile); })).mockRejectedValue(new api.ApiError(403, 'Denied'));
  const onRestored = vi.fn(async (_ids: string[]) => {});
  const props = { files: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], disabled: false, onRestored };
  const view = render(<BulkRestore {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Restore 2 selected files' }));
  view.rerender(<BulkRestore {...props} visible={false} />);
  expect(screen.getByText('Restoring 0 of 2…')).toBeTruthy();
  view.rerender(<BulkRestore {...props} />);
  expect(screen.queryByRole('button', { name: 'Restore 2 selected files' })).toBeNull();
  await act(async () => finish());
  await screen.findByText(/No permission to restore 1 file: B/);
  expect(restore).toHaveBeenCalledTimes(2);
  expect(onRestored).toHaveBeenCalledExactlyOnceWith(['a']);
});
it.each([new api.ApiError(401, 'Expired'), new TypeError('Offline')])('stops remaining requests for a session or connection failure', async error => {
  const restore = vi.spyOn(api, 'restoreFile').mockRejectedValue(error);
  render(<BulkRestore files={[{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]} disabled={false} onRestored={async () => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Restore 2 selected files' }));
  await screen.findByText(/1 file was not attempted/);
  expect(restore).toHaveBeenCalledOnce();
  expect(screen.getByRole('status').textContent).toContain(error instanceof TypeError ? 'Reconnect' : 'Sign in');
});
it('shows progress and cancels only the requests that have not started', async () => {
  let finish!: () => void;
  const restore = vi.spyOn(api, 'restoreFile').mockResolvedValueOnce({} as api.DriveFile)
    .mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({} as api.DriveFile); }));
  const onRestored = vi.fn(async (_ids: string[]) => {});
  render(<BulkRestore files={['a', 'b', 'c'].map(id => ({ id, name: id }))} disabled={false} onRestored={onRestored} />);
  fireEvent.click(screen.getByRole('button', { name: 'Restore 3 selected files' }));
  await screen.findByText('Restoring 1 of 3…');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel remaining restores' }));
  await act(async () => finish());
  await screen.findByText(/Stopped. 1 file was not attempted/);
  expect(restore).toHaveBeenCalledTimes(2);
  expect(onRestored).toHaveBeenCalledExactlyOnceWith(['a', 'b']);
});
it('distinguishes transient retry advice from permission and availability refusals', async () => {
  vi.spyOn(api, 'restoreFile').mockRejectedValueOnce(new api.ApiError(403, 'Denied'))
    .mockRejectedValueOnce(new api.ApiError(404, 'Gone')).mockRejectedValueOnce(new api.ApiError(503, 'Unavailable'));
  render(<BulkRestore files={['denied', 'gone', 'retry'].map(id => ({ id, name: id }))} disabled={false} onRestored={async () => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Restore 3 selected files' }));
  await screen.findByText(/Retry these files/);
  const message = screen.getByRole('status').textContent;
  expect(message).toContain('No permission to restore 1 file: denied.');
  expect(message).toContain('gone. Refresh to check availability.');
  expect(message).toContain('retry. Retry these files.');
});
