import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useUploadQueue } from './upload-queue';
import * as api from './api';
afterEach(() => { cleanup(); vi.restoreAllMocks(); api.selectSite(null); });
function harness(changed = vi.fn(async () => {})) {
  let enqueue!: ReturnType<typeof useUploadQueue>['enqueue'];
  function Harness() { const queue = useUploadQueue(changed); enqueue = queue.enqueue; return queue.panel; }
  render(<Harness />); return { enqueue: (...args: Parameters<typeof enqueue>) => act(() => enqueue(...args)), changed };
}
const files = (...names: string[]) => names.map(name => new File([name], name));
it('finishes the active request, holds pending files, and resumes their captured destination', async () => {
  let finish!: () => void;
  const upload = vi.spyOn(api, 'uploadFile').mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({} as api.DriveFile); }))
    .mockResolvedValue({} as api.DriveFile);
  const { enqueue, changed } = harness();
  api.selectSite('space-a'); enqueue('folder-a', 'A', files('a.txt', 'b.txt'));
  fireEvent.click(screen.getByRole('button', { name: 'Pause uploads' }));
  expect(upload.mock.calls[0]![3]!.aborted).toBe(false);
  await act(async () => finish()); await screen.findByText('1 of 2 uploaded');
  expect(upload).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledOnce();
  const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  api.selectSite('space-b'); enqueue('folder-b', 'B', files('c.txt'));
  expect(upload).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Resume uploads' }));
  await screen.findByText('3 of 3 uploaded');
  expect(upload.mock.calls.map(([folder, file, site]) => [folder, file.name, site])).toEqual([
    ['folder-a', 'a.txt', 'space-a'], ['folder-a', 'b.txt', 'space-a'], ['folder-b', 'c.txt', 'space-b'],
  ]);
  const completed = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(completed);
  expect(completed.defaultPrevented).toBe(false);
});
it('resumes during the active request without creating a second pump', async () => {
  let finish!: () => void;
  const upload = vi.spyOn(api, 'uploadFile').mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({} as api.DriveFile); }))
    .mockResolvedValue({} as api.DriveFile);
  harness().enqueue('root', 'Root', files('a.txt', 'b.txt'));
  fireEvent.click(screen.getByRole('button', { name: 'Pause uploads' }));
  fireEvent.click(screen.getByRole('button', { name: 'Resume uploads' }));
  expect(upload).toHaveBeenCalledTimes(1);
  await act(async () => finish()); await screen.findByText('2 of 2 uploaded');
  expect(upload).toHaveBeenCalledTimes(2);
});
it('cancels paused pending files and releases the navigation guard', async () => {
  let finish!: () => void;
  const upload = vi.spyOn(api, 'uploadFile').mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({} as api.DriveFile); }));
  harness().enqueue('root', 'Root', files('a.txt', 'b.txt'));
  fireEvent.click(screen.getByRole('button', { name: 'Pause uploads' }));
  await act(async () => finish()); await screen.findByText('1 of 2 uploaded');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel queued uploads' }));
  await screen.findByText('1 of 2 uploaded · 1 cancelled');
  fireEvent.click(screen.getByRole('button', { name: 'Resume uploads' }));
  await waitFor(() => expect(upload).toHaveBeenCalledOnce());
  const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(false);
});
