import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DriveScreen } from './drive';
import { selectSite } from './api';
import * as drafts from './drafts';
import { useNavigationGuard } from './navigation-guards';
import { openSpace } from './space-navigation';
vi.mock('./live-updates', () => ({ watchDriveChanges: () => () => {} }));
afterEach(() => { cleanup(); selectSite(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const shell = { onError: () => {}, auth: { user: {}, principal: 'ada' }, onSignIn: () => {}, onSignOut: () => {} };
const stamp = { created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null, current_version_id: null };
const plans = { id: 'plans', parent_id: 'root', name: 'Plans', path: 'Plans' };
const q1 = { id: 'q1', parent_id: 'plans', name: 'Q1', path: 'Plans/Q1' };
const note = { ...stamp, id: 'note', folder_id: 'plans', name: 'note.txt' };

function serve() {
  const routes: Record<string, unknown> = {
    '/api/sites': [{ slug: 'home', name: 'Home', current: true }],
    '/api/folders/root/folders': [plans],
    '/api/folders/plans/folders': [q1],
    '/api/folders/plans/files': [note],
    '/api/shared-folders': { folders: [] },
  };
  const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(routes[url.split('?')[0]!] ?? (url.endsWith('/access') ? { canManage: false } : []))));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
/** jsdom moves history on a later task, as a browser does. */
const go = async (delta: number) => {
  const moved = new Promise(resolve => window.addEventListener('popstate', resolve, { once: true }));
  await act(async () => { history.go(delta); await moved; });
};
const start = async () => {
  selectSite('home'); const fetcher = serve(); render(<DriveScreen {...shell} />);
  await waitFor(() => expect(location.search).toBe('?site=home'));
  return fetcher;
};
const intoPlans = async () => {
  fireEvent.doubleClick(await screen.findByText('Plans'));
  await screen.findByText('note.txt');
};

it('steps back and forward through folders, reading each listing again', async () => {
  const fetcher = await start();
  await intoPlans();
  expect(location.search).toBe('?site=home&folder=plans');
  fetcher.mockClear();
  await go(-1);
  await screen.findByText('Plans');
  expect(location.search).toBe('?site=home');
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === '/api/folders/root/files')).toBe(true));
  await go(1);
  await screen.findByText('note.txt');
  expect(location.search).toBe('?site=home&folder=plans');
});

it('gives one Back per move: tidying the address writes no entry, and neither does following history', async () => {
  const before = history.length;
  await start();
  expect(history.length).toBe(before);
  await intoPlans();
  expect(history.length).toBe(before + 1);
  await go(-1);
  await screen.findByText('Plans');
  expect(history.length).toBe(before + 1);
});

it('restores the crumb trail from the entry', async () => {
  await start();
  await intoPlans();
  fireEvent.doubleClick(await screen.findByText('Q1'));
  await waitFor(() => expect(location.search).toBe('?site=home&folder=q1'));
  await go(-1);
  await screen.findByText('note.txt');
  expect((history.state as { crumbs: { name: string }[] }).crumbs.map(crumb => crumb.name)).toEqual(['Plans']);
});

it('closes a preview on Back and reopens it on Forward', async () => {
  await start();
  await intoPlans();
  fireEvent.doubleClick(screen.getByText('note.txt'));
  await screen.findByRole('button', { name: 'Close preview' });
  await go(-1);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Close preview' })).toBeNull());
  expect(location.search).toBe('?site=home&folder=plans');
  await go(1);
  await screen.findByRole('button', { name: 'Close preview' });
});

it('returns from Trash to the folder it was opened from', async () => {
  await start();
  await intoPlans();
  fireEvent.click(screen.getByRole('button', { name: 'Trash' }));
  await waitFor(() => expect(location.search).toBe('?site=home&view=trash'));
  await go(-1);
  await screen.findByText('note.txt');
  expect(location.search).toBe('?site=home&folder=plans');
});

it('keeps the screen and puts the address back when Back would discard a draft', async () => {
  await start();
  await intoPlans();
  fireEvent.doubleClick(screen.getByText('note.txt'));
  await screen.findByRole('button', { name: 'Close preview' });
  vi.spyOn(drafts, 'confirmDiscardDrafts').mockReturnValue(false);
  await go(-1);
  expect(screen.getByRole('button', { name: 'Close preview' })).toBeTruthy();
  expect(location.search).toBe('?site=home&file=note');
});

it('asks before reloading an entry it has no state for, and stays put on a no', async () => {
  function Busy() { useNavigationGuard(true); return null; }
  await start();
  render(<Busy />);
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  history.replaceState(null, '', '/?site=home&folder=elsewhere');
  await act(async () => { window.dispatchEvent(new PopStateEvent('popstate', { state: null })); });
  expect(location.search).toBe('?site=home');
});

it('adds an entry for a space switch, so Back returns to the space left', () => {
  selectSite('home'); history.replaceState(null, '', '/?site=home&folder=plans');
  const before = history.length;
  vi.stubGlobal('confirm', () => true);
  try { openSpace('family'); } catch { /* jsdom has no reload */ }
  expect(history.length).toBe(before + 1);
  expect(location.search).toBe('?site=family');
});
