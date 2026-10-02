import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CommentsPanel } from './comments';
import * as live from './live-updates';
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('refreshes every browsed page on a file event without discarding the draft, and unsubscribes', async () => {
  let changed!: () => void;
  const stop = vi.fn();
  vi.spyOn(live, 'watchDriveChanges').mockImplementation(callback => { changed = callback; return stop; });
  let updated = false;
  vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify([
    { id: url.includes('cursor') ? '02' : '01', body: url.includes('cursor') ? (updated ? 'Updated second page' : 'Second page') : 'First page', authorLabel: 'Ada', created_at: '2026-01-01', canDelete: false }
  ]), { headers: url.includes('cursor') ? {} : { Link: '</api/files/file/comments?cursor=01>; rel="next"' } }));
  const view = render(<CommentsPanel fileId="file" />);
  await screen.findByText('First page');
  fireEvent.click(screen.getByRole('button', { name: 'Load more comments' }));
  await screen.findByText('Second page');
  fireEvent.change(screen.getByLabelText('New comment'), { target: { value: 'Keep my draft' } });
  updated = true;
  act(() => changed());
  await screen.findByText('Updated second page');
  expect(screen.getByText('First page')).toBeTruthy();
  expect((screen.getByLabelText('New comment') as HTMLTextAreaElement).value).toBe('Keep my draft');
  expect(live.watchDriveChanges).toHaveBeenCalledWith(expect.any(Function), { entityType: 'file', entityId: 'file' });
  view.unmount();
  expect(stop).toHaveBeenCalledOnce();
});
it('coalesces hints during post, retains the new row beyond the loaded page, and keeps input usable during replay', async () => {
  let changed!: () => void;
  vi.spyOn(live, 'watchDriveChanges').mockImplementation(callback => { changed = callback; return () => {}; });
  let finishPost!: (response: Response) => void;
  let finishRefresh!: (response: Response) => void;
  let reads = 0;
  const old = { id: '01', body: 'Old', authorLabel: 'Ada', created_at: '2026-01-01', canDelete: false };
  const page = () => new Response(JSON.stringify([old]), { headers: { Link: '</api/files/file/comments?cursor=01>; rel="next"' } });
  vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return new Promise(resolve => { finishPost = resolve; });
    reads++;
    if (reads === 3) return new Promise(resolve => { finishRefresh = resolve; });
    return Promise.resolve(page());
  });
  render(<CommentsPanel fileId="file" />);
  await screen.findByText('Old');
  fireEvent.change(screen.getByLabelText('New comment'), { target: { value: 'My newest comment' } });
  fireEvent.click(screen.getByRole('button', { name: 'Post comment' }));
  act(() => changed());
  expect(reads).toBe(1);
  await act(async () => { finishPost(new Response(JSON.stringify({ ...old, id: '99', body: 'My newest comment', canDelete: true }))); });
  await vi.waitFor(() => expect(reads).toBe(2));
  expect(screen.getByText('My newest comment')).toBeTruthy();
  const input = screen.getByLabelText('New comment') as HTMLTextAreaElement;
  input.focus();
  fireEvent.change(input, { target: { value: 'Next draft' } });
  act(() => changed());
  expect(input.disabled).toBe(false);
  expect(document.activeElement).toBe(input);
  await act(async () => { finishRefresh(page()); });
  expect(input.value).toBe('Next draft');
  expect(screen.getByText('My newest comment')).toBeTruthy();
});
it('background replay neither clears a failed post error nor publishes its own failure', async () => {
  let changed!: () => void;
  vi.spyOn(live, 'watchDriveChanges').mockImplementation(callback => { changed = callback; return () => {}; });
  let failRead = false;
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return new Response(JSON.stringify({ detail: 'Post denied' }), { status: 403 });
    if (failRead) throw new Error('Background network failure');
    return new Response(JSON.stringify([]));
  });
  render(<CommentsPanel fileId="file" />);
  await screen.findByText('No comments yet.');
  fireEvent.change(screen.getByLabelText('New comment'), { target: { value: 'draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Post comment' }));
  await screen.findByText('Post denied');
  await act(async () => { changed(); });
  expect(screen.getByRole('alert').textContent).toBe('Post denied');
  failRead = true;
  await act(async () => { changed(); });
  expect(screen.getByRole('alert').textContent).toBe('Post denied');
  expect((screen.getByLabelText('New comment') as HTMLTextAreaElement).disabled).toBe(false);
});

it('defers live refresh during deletion and runs it after deletion completes', async () => {
  let changed!: () => void;
  vi.spyOn(live, 'watchDriveChanges').mockImplementation(callback => { changed = callback; return () => {}; });
  let finishDelete!: (response: Response) => void;
  let reads = 0;
  let deleted = false;
  vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return new Promise(resolve => { finishDelete = resolve; });
    reads++;
    return Promise.resolve(new Response(JSON.stringify(deleted ? [] : [{ id: '01', body: 'Mine', authorLabel: 'Ada', created_at: '2026-01-01', canDelete: true }])));
  });
  render(<CommentsPanel fileId="file" />);
  await screen.findByText('Mine');
  fireEvent.click(screen.getByRole('button', { name: 'Delete comment' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
  act(() => { changed(); changed(); });
  expect(reads).toBe(1);
  deleted = true;
  await act(async () => { finishDelete(new Response('{}')); });
  await screen.findByText('No comments yet.');
  expect(reads).toBe(2);
});
