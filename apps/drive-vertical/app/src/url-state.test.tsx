import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DriveScreen } from './drive';
import { folderLoginUrl, linkedView } from './folder-links';
import { offlineSiteKey, selectSite } from './api';
import * as mirror from './scope-mirror';
vi.mock('./live-updates', () => ({ watchDriveChanges: () => () => {} }));
afterEach(() => { cleanup(); selectSite(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const shell = { onError: () => {}, auth: { user: {}, principal: 'ada' }, onSignIn: () => {}, onSignOut: () => {} };
const stamp = { created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null, current_version_id: null };
const plans = { id: 'plans', parent_id: 'root', name: 'Plans', path: 'Plans' };
const note = { ...stamp, id: 'note', folder_id: 'plans', name: 'note.txt' };

function serve(overrides: Record<string, unknown> = {}) {
  const routes: Record<string, unknown> = {
    '/api/sites': [{ slug: 'home', name: 'Home', current: true }, { slug: 'family', name: 'Family', current: false }],
    '/api/folders/root/folders': [plans],
    '/api/folders/plans/files': [note],
    '/api/folders/plans/metadata': { ...plans, canManage: false },
    '/api/shared-folders': { folders: [] },
    ...overrides,
  };
  const fetcher = vi.fn(async (url: string) => {
    const body = await routes[url.split('?')[0]!];
    if (body instanceof Response) return body.clone();
    return new Response(JSON.stringify(body ?? (url.endsWith('/access') ? { canManage: false } : [])));
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const opened = async () => { fireEvent.doubleClick(await screen.findByText('Plans')); await screen.findByText('note.txt'); };

it('names the space and folder on screen, even when the space came from the hostname', async () => {
  serve(); render(<DriveScreen {...shell} />);
  await waitFor(() => expect(location.search).toBe('?site=home'));
  await opened();
  expect(location.search).toBe('?site=home&folder=plans');
  fireEvent.click(screen.getByRole('button', { name: 'My Drive' }));
  await waitFor(() => expect(location.search).toBe('?site=home'));
});

it('adds an open file to the address and goes back to the folder when it closes', async () => {
  selectSite('home'); serve(); render(<DriveScreen {...shell} />);
  await opened();
  fireEvent.doubleClick(screen.getByText('note.txt'));
  await waitFor(() => expect(location.search).toBe('?site=home&file=note'));
  fireEvent.click(await screen.findByRole('button', { name: 'Close preview' }));
  await waitFor(() => expect(location.search).toBe('?site=home&folder=plans'));
});

it.each(['trash', 'shared'] as const)('keeps the %s view in the address and opens on it', async view => {
  selectSite('home'); const fetcher = serve(); const first = render(<DriveScreen {...shell} />);
  await opened();
  fireEvent.click(screen.getByRole('button', { name: view === 'trash' ? 'Trash' : 'Shared with me' }));
  await waitFor(() => expect(location.search).toBe(`?site=home&view=${view}`));
  first.unmount(); fetcher.mockClear();
  render(<DriveScreen {...shell} />);
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes(view === 'trash' ? '/trash' : '/shared-folders'))).toBe(true));
  expect(location.search).toBe(`?site=home&view=${view}`);
});

it('leaves a link in place until it resolves', async () => {
  selectSite('home'); history.replaceState(null, '', '/?site=home&folder=plans');
  let finish!: (response: Response) => void;
  const fetcher = serve({ '/api/folders/plans/metadata': new Promise<Response>(resolve => { finish = resolve; }) });
  render(<DriveScreen {...shell} />);
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === '/api/folders/plans/metadata')).toBe(true));
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === '/api/sites')).toBe(true));
  expect(location.search).toBe('?site=home&folder=plans');
  finish(new Response(JSON.stringify({ ...plans, canManage: false })));
  await screen.findByText('note.txt');
  expect(location.search).toBe('?site=home&folder=plans');
});

it('keeps a link a reload can still open, and retires one that cannot', async () => {
  selectSite('home'); history.replaceState(null, '', '/?site=home&folder=plans');
  serve({ '/api/folders/plans/metadata': new Response('Down', { status: 503 }) });
  const failed = render(<DriveScreen {...shell} />);
  await screen.findByText('Could not open the folder link. Reload to retry.');
  expect(location.search).toBe('?site=home&folder=plans');
  failed.unmount();

  serve({ '/api/folders/plans/metadata': new Response('Gone', { status: 404 }) });
  render(<DriveScreen {...shell} />);
  await screen.findByText('This folder is unavailable or you do not have access.');
  await waitFor(() => expect(location.search).toBe('?site=home'));
});

it('lets the address follow the screen again once the person moves on from a failed link', async () => {
  selectSite('home'); history.replaceState(null, '', '/?site=home&folder=plans');
  serve({ '/api/folders/plans/metadata': new Response('Down', { status: 503 }), '/api/folders/root/files': [{ ...note, folder_id: 'root' }] });
  render(<DriveScreen {...shell} />);
  await screen.findByText('Could not open the folder link. Reload to retry.');
  const depth = history.length;
  fireEvent.doubleClick(await screen.findByText('note.txt'));
  await waitFor(() => expect(new URLSearchParams(location.search).get('file')).toBe('note'));
  // A new entry, so Back still reaches the link a reload can open.
  expect(history.length).toBe(depth + 1);
});

it('leaves the rest of the URL alone', async () => {
  selectSite('home'); history.replaceState(null, '', '/?keep=1#frag');
  serve(); render(<DriveScreen {...shell} />);
  await opened();
  expect(new URLSearchParams(location.search).get('keep')).toBe('1');
  expect(location.hash).toBe('#frag');
});

it('stores the offline identity under the slug the address now names', async () => {
  const remember = vi.spyOn(mirror, 'rememberOfflineIdentity').mockResolvedValue();
  serve(); render(<DriveScreen {...shell} />);
  await waitFor(() => expect(remember).toHaveBeenCalledWith(offlineSiteKey('home'), 'ada'));
});

it('reads a view only from a link for the active space, and carries it through sign-in', () => {
  selectSite('home'); history.replaceState(null, '', '/?site=home&view=trash&invite=secret');
  expect(linkedView()).toBe('trash');
  expect(new URL(folderLoginUrl(), location.origin).searchParams.get('returnTo')).toBe('/?site=home&view=trash');
  selectSite('other'); expect(linkedView()).toBe('drive');
  history.replaceState(null, '', '/?view=search'); expect(linkedView()).toBe('drive');
});
