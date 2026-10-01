import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { openDB } from 'idb';
import App from './App';
import { selectSite } from './api';
import { indexedMirror, offlineIdentity, rememberOfflineIdentity, resumeMirror } from './scope-mirror';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  selectSite(null);
});

it('opens a completed mirror during an outage but revokes it after an online 401', async () => {
  const principal = '01ADA';
  const siteKey = JSON.stringify([window.location.origin, null]);
  await resumeMirror();
  const epoch = (await indexedMirror.progress(principal))?.epoch;
  await indexedMirror.apply(principal, {
    cursor: '01EVENT', hasMore: false, changes: [{
      id: '01EVENT', type: 'drive.folder-created', entityType: 'folder', entityId: 'docs',
      folder: { id: 'docs', parent_id: 'root', name: 'Saved Docs', path: 'Saved Docs' },
    }],
  }, null, epoch);
  await rememberOfflineIdentity(siteKey, principal);

  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network unavailable')));
  const offline = render(<App />);
  expect(await screen.findByText('Saved Docs')).toBeTruthy();
  expect(screen.getByText(/Offline — showing saved file and folder names/)).toBeTruthy();
  expect(screen.queryByText('Sign in to this space')).toBeNull();
  offline.unmount();

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({}),
  }));
  render(<App />);
  expect(await screen.findByText('Sign in to this space')).toBeTruthy();
  await waitFor(async () => {
    const database = await openDB('canopy.scope-mirror', 1);
    expect(await database.getAll('folders')).toEqual([]);
  });
  expect(await offlineIdentity(siteKey)).toBeNull();
});
