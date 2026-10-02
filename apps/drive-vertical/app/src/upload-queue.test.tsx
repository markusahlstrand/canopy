import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useUploadQueue } from './upload-queue';
import * as api from './api';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
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
  expect(changed).toHaveBeenCalledTimes(3);
});
