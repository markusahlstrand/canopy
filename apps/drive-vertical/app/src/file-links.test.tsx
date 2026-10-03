import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DriveScreen } from './drive';
import App from './App';
import { fileLink, linkedFileId } from './file-links';
import { folderLoginUrl } from './folder-links';
import { selectSite } from './api';
import { CopyFileLink, FileLinkAction } from './copy-file-link';
vi.mock('./live-updates', () => ({ watchDriveChanges: () => () => {} }));
afterEach(() => { cleanup(); selectSite(null); history.replaceState(null, '', '/'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const shell = { onError: () => {}, auth: { user: {} }, onSignIn: () => {}, onSignOut: () => {} };
const metadata = { file: { id: 'stable', folder_id: 'private-folder', name: 'Renamed.zip', current_version_id: 'v' }, version: { id: 'v', source: 'blob', mime: 'application/zip', size: 1 }, canWrite: false };
function mockFiles(status = 200) {
  const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/files/stable' ? metadata
    : url === '/api/folders/private-folder/metadata' ? { id: 'private-folder', name: 'Shared folder', path: 'Shared folder', canManage: false } : url.endsWith('/access') ? { canManage: false } : []), { status: url === '/api/files/stable' ? status : 200 }));
  vi.stubGlobal('fetch', fetcher); return fetcher;
}
it('uses only scoped opaque IDs and preserves the file destination through login', () => {
  selectSite('family'); history.replaceState(null, '', '/?site=family&file=id%2Fwith+%26+chars&folder=other&path=Secret&invite=credential');
  const link = new URL(fileLink('id/with & chars'));
  expect([...link.searchParams.keys()]).toEqual(['site', 'file']);
  expect(linkedFileId()).toBe('id/with & chars');
  expect(new URL(folderLoginUrl(), location.origin).searchParams.get('returnTo')).toBe(link.pathname + link.search);
  selectSite('other'); expect(linkedFileId()).toBe(''); expect(folderLoginUrl()).not.toContain('returnTo');
});
it('opens a renamed file in its containing folder without resolving legacy links or private ancestors', async () => {
  selectSite('family'); history.replaceState(null, '', '/?site=family&file=stable&folder=old&path=Old/Name');
  const fetcher = mockFiles(); render(<DriveScreen {...shell} />);
  await screen.findByText('Renamed.zip');
  expect(fetcher.mock.calls.some(([url]) => url.includes('/old/') || url.includes('by-path'))).toBe(false);
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === '/api/folders/private-folder/files')).toBe(true));
  expect(fetcher.mock.calls.some(([url]) => url.includes('/folders/root/'))).toBe(false);
  expect(location.search).toBe('?site=family');
});
it.each([401, 403, 404])('reports a generic unavailable file without exposing metadata (%s)', async status => {
  history.replaceState(null, '', '/?file=stable'); mockFiles(status); render(<DriveScreen {...shell} />);
  await screen.findByText('This file is unavailable or you do not have access.');
  expect(screen.queryByText('Renamed.zip')).toBeNull(); expect(location.search).toBe('');
});
it('retires an unresolved link when the screen unmounts', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn((url: string) => url === '/api/files/stable' ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(new Response(JSON.stringify([]))));
  history.replaceState(null, '', '/?file=stable'); vi.stubGlobal('fetch', fetcher);
  const view = render(<DriveScreen {...shell} />); view.unmount();
  await act(async () => finish(new Response(JSON.stringify(metadata))));
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/files/stable')).toHaveLength(1);
});
it('looks up the implicit space only when the panel opens and copies during the click', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify([{ slug: 'family', current: true }]))); vi.stubGlobal('fetch', fetcher);
  const writeText = vi.fn(async (_url: string) => {}); vi.stubGlobal('navigator', { clipboard: { writeText } });
  render(<FileLinkAction fileId="stable" />); expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'File link' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Copy file link' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Copy file link' }));
  expect(writeText).toHaveBeenCalledExactlyOnceWith(`${location.origin}/?site=family&file=stable`);
  await screen.findByText('File link copied.');
});
it('offers the prepared address when clipboard fails and clears it on file changes', async () => {
  selectSite('family'); vi.stubGlobal('navigator', { clipboard: { writeText: () => Promise.reject(new Error('Denied')) } });
  const view = render(<CopyFileLink fileId="first" />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Copy file link' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Copy file link' }));
  await screen.findByText('Could not copy the link. Copy the address below instead.');
  expect(screen.getByLabelText('File link').getAttribute('value')).toContain('file=first');
  view.rerender(<CopyFileLink fileId="second" />);
  await waitFor(() => expect(screen.getByLabelText('File link').getAttribute('value')).toContain('file=second'));
  expect(screen.queryByText(/Could not copy/)).toBeNull();
});
it('retires a late implicit-space answer instead of making a wrong-space link ready', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', () => new Promise<Response>(resolve => { finish = resolve; }));
  render(<CopyFileLink fileId="stable" />); selectSite('other');
  await act(async () => finish(new Response(JSON.stringify([{ slug: 'old', current: true }]))));
  expect(screen.getByRole('button', { name: 'Copy file link' }).hasAttribute('disabled')).toBe(true);
  expect(screen.queryByLabelText('File link')).toBeNull();
});

it('drops a foreign file destination when authentication falls back to another space', async () => {
  selectSite('revoked'); history.replaceState(null, '', '/?site=revoked&file=foreign-file');
  let meReads = 0;
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/me')) return ++meReads === 1 ? new Response('Unauthorized', { status: 401 }) : new Response(JSON.stringify({ principal: 'ada' }));
    return new Response(JSON.stringify(url.endsWith('/sites') ? [{ slug: 'home', name: 'Home', current: true }]
      : url === '/api/folders/private-folder/metadata' ? { id: 'private-folder', name: 'Shared folder', path: 'Shared folder', canManage: false } : url.endsWith('/access') ? { canManage: false } : []));
  });
  vi.stubGlobal('fetch', fetcher); render(<App />);
  await screen.findByRole('complementary');
  expect(location.search).not.toContain('file='); expect(location.search).not.toContain('site=');
  expect(fetcher.mock.calls.some(([url]) => url.includes('foreign-file'))).toBe(false);
});

it('does not list a forbidden root for a folder-only reader, and keeps the preview if folder context fails', async () => {
  history.replaceState(null, '', '/?file=stable');
  const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/files/stable' ? metadata : { detail: 'Denied' }), { status: url === '/api/files/stable' ? 200 : 403 }));
  vi.stubGlobal('fetch', fetcher); render(<DriveScreen {...shell} />);
  await screen.findByText('Folder context unavailable'); await screen.findByText('Renamed.zip');
  expect(fetcher.mock.calls.some(([url]) => url.includes('/folders/root/'))).toBe(false);
  expect(screen.queryByText("Couldn't load this view")).toBeNull();
});
