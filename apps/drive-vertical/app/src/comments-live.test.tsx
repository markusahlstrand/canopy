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
