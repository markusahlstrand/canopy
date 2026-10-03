import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DriveScreen } from './drive';
import { selectSite } from './api';
vi.mock('./live-updates', () => ({ watchDriveChanges: () => () => {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); selectSite(null); });
const shell = { onError: () => {}, auth: { user: {} }, onSignIn: () => {}, onSignOut: () => {} };
function setup(desc = false) {
  localStorage.setItem('canopy.drive.view', JSON.stringify({ version: 1, layout: 'list', sort: { key: 'name', dir: desc ? 'desc' : 'asc' } }));
  const fetcher = vi.fn(async (url: string) => {
    if (url.includes('/content')) return new Response('original');
    if (/^\/api\/files\/[ab]$/.test(url)) return new Response(JSON.stringify({
      file: { id: url.slice(-1), name: url.endsWith('a') ? 'alpha.txt' : 'beta.txt' },
      version: { id: 'v1', source: 'blob', mime: 'text/plain' }, canWrite: true,
    }));
    if (url.endsWith('/files')) return new Response(JSON.stringify([
      { id: 'b', name: 'beta.txt', state: 'live' }, { id: 'a', name: 'alpha.txt', state: 'live' },
    ]));
    if (url.endsWith('/folders')) return new Response(JSON.stringify([{ id: 'folder', name: 'Between', path: 'Between' }]));
    return new Response(JSON.stringify(url.endsWith('/access') ? { canManage: false } : []));
  });
  vi.stubGlobal('fetch', fetcher); render(<DriveScreen {...shell} />); return fetcher;
}
it.each([false, true])('navigates files in the displayed sort order (descending=%s) and stops at boundaries', async desc => {
  setup(desc);
  fireEvent.doubleClick(await screen.findByText(desc ? 'beta.txt' : 'alpha.txt'));
  const panel = await screen.findByLabelText('Preview');
  await within(panel).findByRole('button', { name: 'Edit text' });
  expect((within(panel).getByRole('button', { name: 'Previous file' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(panel).getByRole('button', { name: 'Next file' }));
  await within(panel).findByRole('heading', { name: desc ? 'alpha.txt' : 'beta.txt' });
  expect((within(panel).getByRole('button', { name: 'Next file' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(panel).getByRole('button', { name: 'Previous file' }));
  await within(panel).findByRole('heading', { name: desc ? 'beta.txt' : 'alpha.txt' });
});
it('asks before discarding an editor draft on next-file navigation', async () => {
  const fetcher = setup(); const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  fireEvent.doubleClick(await screen.findByText('alpha.txt'));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit text' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'File text' }), { target: { value: 'draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Next file' }));
  expect(confirm).toHaveBeenCalledOnce(); expect(screen.getByDisplayValue('draft')).toBeTruthy();
  expect(fetcher.mock.calls.some(([url]) => url === '/api/files/b')).toBe(false);
  confirm.mockReturnValue(true); fireEvent.click(screen.getByRole('button', { name: 'Next file' }));
  await within(screen.getByLabelText('Preview')).findByRole('heading', { name: 'beta.txt' });
  expect(screen.queryByDisplayValue('draft')).toBeNull();
});
