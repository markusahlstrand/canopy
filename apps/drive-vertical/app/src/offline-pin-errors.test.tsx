import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DriveScreen } from './drive';
import { selectSite } from './api';
import { indexedMirror } from './scope-mirror';
import type { FolderPin } from './offline-content';

const refresh = vi.hoisted(() => ({
  onUpdated: null as null | ((error?: unknown, pin?: FolderPin) => void | Promise<void>),
  shouldRun: null as null | (() => boolean),
}));
const pinA: FolderPin = { principal: '01ADA', space: 'family', folderId: 'root', name: 'Family', status: 'syncing', updatedAt: 1 };
const pinB: FolderPin = { ...pinA, folderId: 'docs', name: 'Docs', status: 'ready' };
let rootPin = pinA;
vi.mock('./live-updates', () => ({ watchDriveChanges: () => () => {} }));
vi.mock('./offline-folder-sync', () => ({
  refreshOfflinePins: vi.fn(async (_principal: string, _space: string, _source: unknown, onUpdated: typeof refresh.onUpdated, shouldRun: typeof refresh.shouldRun) => {
    refresh.onUpdated = onUpdated; refresh.shouldRun = shouldRun;
  }),
  syncOfflineFolderOnce: vi.fn(),
}));
vi.mock('./offline-content', async importOriginal => ({
  ...await importOriginal<typeof import('./offline-content')>(),
  listOfflinePins: vi.fn(async () => [rootPin, pinB]),
}));
// The first render loads the drive's lazy modules; keep a cold transform from timing out.
vi.setConfig({ testTimeout: 20_000 });
let listingOffline = false;
afterEach(() => { listingOffline = false; rootPin = pinA; cleanup(); selectSite(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); refresh.onUpdated = null; refresh.shouldRun = null; });

async function renderRootFolder() {
  selectSite('family');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (listingOffline && url.includes('/folders/')) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(
    url.startsWith('/api/sites') ? [{ slug: 'family', name: 'Family', current: true }] : url.endsWith('/access') ? { canManage: false } : [],
    ));
  }));
  render(<DriveScreen auth={{ user: { name: 'ada@example.com' }, principal: '01ADA' }} onError={() => {}} onSignIn={() => {}} onSignOut={() => {}} />);
  await waitFor(() => expect(refresh.onUpdated).not.toBeNull(), { timeout: 10_000 });
  await screen.findByRole('button', { name: 'Saving offline…' }, { timeout: 10_000 });
}

it("keeps a pin's background failure and retry when another pin then succeeds", async () => {
  await renderRootFolder();
  await act(async () => { await refresh.onUpdated!(new Error('Storage full'), pinA); });
  await act(async () => { await refresh.onUpdated!(null, pinB); });
  expect(screen.getByRole('alert').textContent).toContain('Storage full');
  expect((screen.getByRole('button', { name: 'Retry offline download' }) as HTMLButtonElement).disabled).toBe(false);
});

it("does not show another folder's failure on the folder on screen", async () => {
  await renderRootFolder();
  await act(async () => { await refresh.onUpdated!(new Error('Storage full'), pinB); });
  expect(screen.queryByRole('alert')).toBeNull();
  expect((screen.getByRole('button', { name: 'Saving offline…' }) as HTMLButtonElement).disabled).toBe(true);
});

it('lets a delayed refresh see the connection and view at the time it fires', async () => {
  await renderRootFolder();
  expect(refresh.shouldRun!()).toBe(true);
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  expect(refresh.shouldRun!()).toBe(false);
  online.mockRestore();
  const shouldRun = refresh.shouldRun!;
  fireEvent.click(screen.getByRole('button', { name: 'Trash' }));
  await screen.findByText('Trash is empty');
  expect(shouldRun()).toBe(false);
});

it('stops a delayed refresh once the listing has fallen back to saved metadata', async () => {
  vi.spyOn(indexedMirror, 'folder').mockResolvedValue({ folders: [], files: [] });
  await renderRootFolder();
  const shouldRun = refresh.shouldRun!;
  expect(shouldRun()).toBe(true);
  listingOffline = true;
  fireEvent.click(screen.getByLabelText('Refresh'));
  await screen.findByText('No saved files here');
  expect(shouldRun()).toBe(false);
});

it('stops a delayed refresh from running after the drive screen unmounts', async () => {
  await renderRootFolder();
  const shouldRun = refresh.shouldRun!;
  expect(shouldRun()).toBe(true);
  cleanup();
  expect(shouldRun()).toBe(false);
});

it('says when the folder on screen is saved for offline reading, and only then', async () => {
  await renderRootFolder();
  const ready = () => screen.queryByText(/Saved for offline reading on this device/);
  expect(ready()).toBeNull();
  for (const status of ['partial', 'error'] as const) {
    rootPin = { ...pinA, status };
    await act(async () => { await refresh.onUpdated!(undefined, rootPin); });
    await screen.findByRole('button', { name: 'Retry offline download' });
    expect(ready()).toBeNull();
  }
  rootPin = { ...pinA, status: 'ready', updatedAt: Date.now() };
  await act(async () => { await refresh.onUpdated!(undefined, rootPin); });
  await screen.findByRole('button', { name: 'Remove offline copy' });
  expect(ready()?.getAttribute('role')).toBe('status');
  expect(ready()?.querySelector('time')?.getAttribute('dateTime')).toBe(new Date(rootPin.updatedAt).toISOString());
  await act(async () => { await refresh.onUpdated!(new Error('Storage full'), rootPin); });
  expect(screen.getByRole('alert').textContent).toContain('Storage full');
  expect(ready()).toBeNull();
});
