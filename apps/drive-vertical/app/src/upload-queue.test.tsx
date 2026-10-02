import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useUploadQueue } from './upload-queue';
import * as api from './api';
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); api.selectSite(null); });
it('serializes uploads, continues after failure and retries only the failed item to its original folder', async () => {
  let finish!: () => void;
  const upload = vi.spyOn(api, 'uploadFile').mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({} as api.DriveFile); }))
    .mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValue({} as api.DriveFile);
  const changed = vi.fn(async () => {});
  let enqueue!: ReturnType<typeof useUploadQueue>['enqueue'];
  function Harness() { const queue = useUploadQueue(changed); enqueue = queue.enqueue; return queue.panel; }
  render(<Harness />);
  act(() => enqueue('original-folder', 'Papers', [new File(['a'], 'a.txt'), new File(['b'], 'b.txt'), new File(['c'], 'c.txt')]));
  expect(upload).toHaveBeenCalledTimes(1);
  expect(screen.getAllByText('Queued')).toHaveLength(2);
  act(() => finish());
  await screen.findByText('Connection lost');
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
  await screen.findByText('2 of 3 uploaded');
  fireEvent.click(screen.getByRole('button', { name: 'Retry b.txt' }));
  await screen.findByText('3 of 3 uploaded');
  expect(upload.mock.calls.map(([folder, file]) => [folder, file.name])).toEqual([
    ['original-folder', 'a.txt'], ['original-folder', 'b.txt'], ['original-folder', 'c.txt'], ['original-folder', 'b.txt']
  ]);
  expect(changed).toHaveBeenCalledTimes(2);
});

it('pins queued and retried uploads to their captured space', async () => {
  api.selectSite('space-a');
  let finish!: (response: Response) => void;
  const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'retry me' }), { status: 500 }))
    .mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  let enqueue!: ReturnType<typeof useUploadQueue>['enqueue'];
  function Harness() { const queue = useUploadQueue(async () => {}); enqueue = queue.enqueue; return queue.panel; }
  render(<Harness />);
  act(() => enqueue('root', 'Space A', [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]));
  api.selectSite('space-b');
  await act(async () => { finish(new Response('{}')); });
  await screen.findByText('retry me');
  fireEvent.click(screen.getByRole('button', { name: 'Retry b.txt' }));
  await screen.findByText('2 of 2 uploaded');
  expect(fetch).toHaveBeenCalledTimes(3);
  for (const [, init] of fetch.mock.calls) expect(init.headers['x-site']).toBe('space-a');
  fireEvent.click(screen.getByRole('button', { name: 'Clear completed uploads' }));
  expect(screen.queryByLabelText('Uploads')).toBeNull();
});


it('cancels one pending file without sending it, while the active upload completes', async () => {
  let finish!: () => void;
  const upload = vi.spyOn(api, 'uploadFile').mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({} as api.DriveFile); })).mockResolvedValue({} as api.DriveFile);
  const changed = vi.fn(async () => {});
  let enqueue!: ReturnType<typeof useUploadQueue>['enqueue'];
  function Harness() { const queue = useUploadQueue(changed); enqueue = queue.enqueue; return queue.panel; }
  render(<Harness />);
  act(() => enqueue('root', 'Root', ['a', 'b', 'c'].map(name => new File([name], `${name}.txt`))));
  expect(screen.queryByRole('button', { name: 'Cancel a.txt' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel b.txt' }));
  expect(screen.getByText('Cancelled')).toBeTruthy();
  await act(async () => { finish(); });
  await screen.findByText('2 of 3 uploaded · 1 cancelled');
  expect(upload.mock.calls.map(([, file]) => file.name)).toEqual(['a.txt', 'c.txt']);
  expect(screen.queryByRole('button', { name: 'Retry b.txt' })).toBeNull();
  expect(changed).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss b.txt' }));
  expect(screen.queryByText('Cancelled')).toBeNull();
});
it('cancels all waiting files and clears the navigation guard once the active upload completes', async () => {
  let finish!: () => void;
  const upload = vi.spyOn(api, 'uploadFile').mockImplementation(() => new Promise(resolve => { finish = () => resolve({} as api.DriveFile); }));
  let enqueue!: ReturnType<typeof useUploadQueue>['enqueue'];
  function Harness() { const queue = useUploadQueue(async () => {}); enqueue = queue.enqueue; return queue.panel; }
  render(<Harness />);
  act(() => enqueue('root', 'Root', ['a', 'b', 'c'].map(name => new File([name], `${name}.txt`))));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel queued uploads' }));
  expect(screen.getAllByText('Cancelled')).toHaveLength(2);
  await act(async () => { finish(); });
  await screen.findByText('1 of 3 uploaded · 2 cancelled');
  expect(upload).toHaveBeenCalledOnce();
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(false);
});
