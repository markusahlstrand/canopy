import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  await screen.findByText(/Could not restore: Refused/);
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
