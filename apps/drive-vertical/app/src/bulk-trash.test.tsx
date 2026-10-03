import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BulkTrash } from './bulk-trash';
import * as api from './api';
afterEach(() => { cleanup(); api.selectSite(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('continues after a refusal and retains the original space throughout a batch', async () => {
  api.selectSite('space-a');
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    api.selectSite('space-b');
    return new Response(JSON.stringify({ id: url }), { status: url.endsWith('/bad') ? 403 : 200 });
  });
  vi.stubGlobal('fetch', fetch);
  const onTrashed = vi.fn(async (_ids: string[]) => {});
  render(<BulkTrash files={[{ id: 'first', name: 'First' }, { id: 'bad', name: 'Refused' }, { id: 'last', name: 'Last' }]} disabled={false} onTrashed={onTrashed} />);
  fireEvent.click(screen.getByRole('button', { name: 'Move 3 selected files to Trash' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm move to Trash' }));
  await screen.findByText(/No permission to trash 1 file: Refused/);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/files/first', '/api/files/bad', '/api/files/last']);
  for (const [, init] of fetch.mock.calls) expect(init?.headers).toMatchObject({ 'x-site': 'space-a' });
  expect(onTrashed).toHaveBeenCalledExactlyOnceWith(['first', 'last']);
});
it('hides the action without a selection and refuses disabled moves', () => {
  const trash = vi.spyOn(api, 'trashFile');
  const props = { disabled: true, onTrashed: async () => {} };
  const view = render(<BulkTrash {...props} files={[]} />);
  expect(screen.queryByRole('button')).toBeNull();
  view.rerender(<BulkTrash {...props} files={[{ id: 'file', name: 'File' }]} />);
  fireEvent.click(screen.getByRole('button'));
  expect(trash).not.toHaveBeenCalled();
});

it('keeps the running batch and its outcome when the Trash controls are hidden', async () => {
  let finish!: () => void;
  const trash = vi.spyOn(api, 'trashFile').mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({} as api.DriveFile); })).mockRejectedValue(new api.ApiError(403, 'Denied'));
  const onTrashed = vi.fn(async (_ids: string[]) => {});
  const props = { files: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], disabled: false, onTrashed };
  const view = render(<BulkTrash {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Move 2 selected files to Trash' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm move to Trash' }));
  view.rerender(<BulkTrash {...props} visible={false} />);
  expect(screen.getByText('Moving to Trash: 0 of 2…')).toBeTruthy();
  view.rerender(<BulkTrash {...props} />);
  expect(screen.queryByRole('button', { name: 'Move 2 selected files to Trash' })).toBeNull();
  await act(async () => finish());
  await screen.findByText(/No permission to trash 1 file: B/);
  expect(trash).toHaveBeenCalledTimes(2);
  expect(onTrashed).toHaveBeenCalledExactlyOnceWith(['a']);
});
it.each([new api.ApiError(401, 'Expired'), new TypeError('Offline')])('stops remaining requests for a session or connection failure', async error => {
  const trash = vi.spyOn(api, 'trashFile').mockRejectedValue(error);
  render(<BulkTrash files={[{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]} disabled={false} onTrashed={async () => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Move 2 selected files to Trash' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm move to Trash' }));
  await screen.findByText(/1 file was not attempted/);
  expect(trash).toHaveBeenCalledOnce();
  expect(screen.getByRole('status').textContent).toContain(error instanceof TypeError ? 'Reconnect' : 'Sign in');
});
it('shows progress and cancels only the requests that have not started', async () => {
  let finish!: () => void;
  const trash = vi.spyOn(api, 'trashFile').mockResolvedValueOnce({} as api.DriveFile)
    .mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({} as api.DriveFile); }));
  const onTrashed = vi.fn(async (_ids: string[]) => {});
  render(<BulkTrash files={['a', 'b', 'c'].map(id => ({ id, name: id }))} disabled={false} onTrashed={onTrashed} />);
  fireEvent.click(screen.getByRole('button', { name: 'Move 3 selected files to Trash' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm move to Trash' }));
  await screen.findByText('Moving to Trash: 1 of 3…');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel remaining moves' }));
  await act(async () => finish());
  await screen.findByText(/Stopped. 1 file was not attempted/);
  expect(trash).toHaveBeenCalledTimes(2);
  expect(onTrashed).toHaveBeenCalledExactlyOnceWith(['a', 'b']);
});
it('distinguishes transient retry advice from permission and availability refusals', async () => {
  vi.spyOn(api, 'trashFile').mockRejectedValueOnce(new api.ApiError(403, 'Denied'))
    .mockRejectedValueOnce(new api.ApiError(404, 'Gone')).mockRejectedValueOnce(new api.ApiError(503, 'Unavailable'));
  render(<BulkTrash files={['denied', 'gone', 'retry'].map(id => ({ id, name: id }))} disabled={false} onTrashed={async () => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Move 3 selected files to Trash' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm move to Trash' }));
  await screen.findByText(/Retry these files/);
  const message = screen.getByRole('status').textContent;
  expect(message).toContain('No permission to trash 1 file: denied.');
  expect(message).toContain('gone. Refresh to check availability.');
  expect(message).toContain('retry. Retry these files.');
});
it('confirms an exact selection and space without mutating until approved', async () => {
  api.selectSite('original');
  const trash = vi.spyOn(api, 'trashFile').mockResolvedValue({} as api.DriveFile);
  const props = { disabled: false, onTrashed: async () => {} };
  const view = render(<BulkTrash {...props} files={[{ id: 'a', name: 'Original file' }]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Move 1 selected file to Trash' }));
  expect(trash).not.toHaveBeenCalled();
  api.selectSite('other');
  view.rerender(<BulkTrash {...props} files={[{ id: 'b', name: 'Other file' }]} />);
  expect(screen.getByRole('group').textContent).toContain('Original file');
  expect(screen.getByRole('group').textContent).not.toContain('Other file');
  fireEvent.click(screen.getByRole('button', { name: 'Confirm move to Trash' }));
  await screen.findByText('Moved to Trash: 1 file.');
  expect(trash).toHaveBeenCalledExactlyOnceWith('a', 'original');
});
it('protects navigation while moving and retires unmounted batches before another request', async () => {
  let finish!: () => void;
  const trash = vi.spyOn(api, 'trashFile').mockImplementation(() => new Promise(resolve => { finish = () => resolve({} as api.DriveFile); }));
  const onTrashed = vi.fn(async () => {});
  const view = render(<BulkTrash files={['a', 'b'].map(id => ({ id, name: id }))} disabled={false} onTrashed={onTrashed} />);
  fireEvent.click(screen.getByRole('button', { name: 'Move 2 selected files to Trash' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm move to Trash' }));
  const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  view.unmount();
  await act(async () => finish());
  expect(trash).toHaveBeenCalledOnce(); expect(onTrashed).not.toHaveBeenCalled();
  const after = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(after);
  expect(after.defaultPrevented).toBe(false);
});
