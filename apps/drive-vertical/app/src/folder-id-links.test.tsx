import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DriveScreen } from './drive';
import { folderIdLink, linkedFolderId, folderLoginUrl } from './folder-links';
import { selectSite } from './api';
import { CopyFolderLink } from './copy-folder-link';
vi.mock('./live-updates', () => ({ watchDriveChanges: () => () => {} }));
afterEach(() => { cleanup(); selectSite(null); history.replaceState(null, '', '/'); vi.unstubAllGlobals(); });
const shell = { onError: () => {}, auth: { user: {} }, onSignIn: () => {}, onSignOut: () => {} };
it('copies a scoped opaque ID without ancestor names or credentials', () => {
  selectSite('family'); history.replaceState(null, '', '/?invite=secret&path=Private/Names');
  const link = new URL(folderIdLink('id/with & characters'));
  expect(link.searchParams.get('folder')).toBe('id/with & characters');
  expect([...link.searchParams.keys()]).toEqual(['site', 'folder']);
  expect(link.searchParams.get('site')).toBe('family');
});
it('opens the same folder after a rename, preferring its ID over a legacy path', async () => {
  selectSite('family'); history.replaceState(null, '', '/?site=family&folder=stable&path=Old/Name');
  const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(
    url === '/api/folders/stable/metadata' ? { id: 'stable', name: 'Renamed', path: 'New/Renamed', canManage: false }
      : url.endsWith('/access') ? { canManage: false } : [])));
  vi.stubGlobal('fetch', fetcher); render(<DriveScreen {...shell} />);
  await screen.findAllByText('New/Renamed');
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === '/api/folders/stable/files')).toBe(true));
  expect(fetcher.mock.calls.some(([url]) => url.includes('by-path') || url === '/api/folders/root/files')).toBe(false);
  expect(location.search).toBe('?site=family');
});
it.each([403, 404])('reports a generic unavailable state for a denied or missing ID (%s)', async status => {
  history.replaceState(null, '', '/?folder=missing');
  vi.stubGlobal('fetch', async (url: string) => url === '/api/folders/missing/metadata'
    ? new Response('Unavailable', { status }) : new Response(JSON.stringify(url.endsWith('/access') ? { canManage: false } : [])));
  render(<DriveScreen {...shell} />);
  await screen.findByText('This folder is unavailable or you do not have access.');
  expect(location.search).toBe('');
});
it('preserves only the folder navigation destination through login and rejects another space', () => {
  selectSite('family'); history.replaceState(null, '', '/?site=family&folder=stable&path=Old&invite=secret');
  expect(new URL(folderLoginUrl(), location.origin).searchParams.get('returnTo')).toBe('/?site=family&folder=stable');
  selectSite('other'); expect(linkedFolderId()).toBe('');
  expect(new URL(folderLoginUrl(), location.origin).searchParams.has('returnTo')).toBe(false);
});

it('copies and opens the space root without a blank crumb or folder parameter', async () => {
  selectSite('family');
  const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/access') ? { canManage: false } : [])));
  vi.stubGlobal('fetch', fetcher);
  const writeText = vi.fn(async (_text: string) => {}); vi.stubGlobal('navigator', { clipboard: { writeText } });
  const copy = render(<CopyFolderLink folderId="root" />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Copy folder link' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Copy folder link' }));
  const link = new URL(writeText.mock.calls[0]![0]); expect(link.search).toBe('?site=family');
  copy.unmount(); history.replaceState(null, '', link.pathname + link.search);
  render(<DriveScreen {...shell} />);
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === '/api/folders/root/files')).toBe(true));
  expect(screen.queryByRole('button', { name: 'Back to parent folder' })).toBeNull();
  expect(fetcher.mock.calls.some(([url]) => url === '/api/folders/root/metadata')).toBe(false);
});
it('also treats an explicit legacy root-ID link as the root with no blank crumb', async () => {
  selectSite('family'); history.replaceState(null, '', '/?site=family&folder=root');
  const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/folders/root/metadata'
    ? { id: 'root', name: '', path: '', canManage: false } : url.endsWith('/access') ? { canManage: false } : [])));
  vi.stubGlobal('fetch', fetcher); render(<DriveScreen {...shell} />);
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === '/api/folders/root/files')).toBe(true));
  expect(screen.queryByRole('button', { name: 'Back to parent folder' })).toBeNull();
  expect(location.search).toBe('?site=family');
});
