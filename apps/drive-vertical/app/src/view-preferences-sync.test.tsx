import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { DriveScreen } from './drive';
import { watchViewPreferences, VIEW_PREFERENCES_KEY as key } from './view-preferences';
import { selectSite } from './api';
vi.mock('./live-updates', () => ({ watchDriveChanges: () => () => {} }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); selectSite(null); });
const value = (layout = 'grid', dir = 'desc') => JSON.stringify({ version: 1, layout, sort: { key: 'name', dir } });
const notify = (eventKey: string | null = key, area: Storage = localStorage, newValue: string | null = null) =>
  window.dispatchEvent(new StorageEvent('storage', { key: eventKey, storageArea: area, newValue }));
it('re-reads the latest value, ignores unrelated storage, and cleans up the listener', () => {
  const changed = vi.fn(); const stop = watchViewPreferences(changed); changed.mockClear();
  localStorage.setItem(key, value());
  notify('unrelated'); notify(key, sessionStorage); expect(changed).not.toHaveBeenCalled();
  notify(key, localStorage, value('list', 'asc'));
  expect(changed).toHaveBeenLastCalledWith({ layout: 'grid', sort: { key: 'name', dir: 'desc' } });
  stop(); changed.mockClear(); notify(); expect(changed).not.toHaveBeenCalled();
});
it('keeps newer-format values untouched and resets after removal or clear', () => {
  localStorage.setItem(key, value());
  const changed = vi.fn(); const stop = watchViewPreferences(changed); changed.mockClear();
  const newer = JSON.stringify({ version: 2, layout: 'future' }); localStorage.setItem(key, newer); notify();
  expect(changed).not.toHaveBeenCalled(); expect(localStorage.getItem(key)).toBe(newer);
  localStorage.removeItem(key); notify();
  expect(changed).toHaveBeenLastCalledWith({ layout: 'list', sort: { key: 'name', dir: 'asc' } });
  localStorage.setItem(key, value()); notify(); localStorage.clear(); notify(null);
  expect(changed).toHaveBeenLastCalledWith({ layout: 'list', sort: { key: 'name', dir: 'asc' } }); stop();
});
it('normalizes malformed values and tolerates denied storage', () => {
  const changed = vi.fn(); const stop = watchViewPreferences(changed); changed.mockClear();
  localStorage.setItem(key, '{bad'); notify();
  expect(changed).toHaveBeenLastCalledWith({ layout: 'list', sort: { key: 'name', dir: 'asc' } });
  changed.mockClear(); vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Denied'); });
  expect(() => notify()).not.toThrow(); expect(changed).not.toHaveBeenCalled(); stop();
});
it('updates the mounted drive layout and sort without echoing writes', async () => {
  const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/files')
    ? [{ id: 'a', name: 'alpha.txt', state: 'live' }, { id: 'b', name: 'beta.txt', state: 'live' }]
    : url.endsWith('/access') ? { canManage: false } : [])));
  vi.stubGlobal('fetch', fetcher);
  render(<DriveScreen onError={() => {}} auth={{ user: {} }} onSignIn={() => {}} onSignOut={() => {}} />);
  await screen.findByText('alpha.txt'); expect(screen.getByRole('button', { name: 'Switch to grid' })).toBeTruthy();
  localStorage.setItem(key, value()); const writes = vi.spyOn(Storage.prototype, 'setItem');
  act(() => notify());
  expect(screen.getByRole('button', { name: 'Switch to list' })).toBeTruthy();
  const cards = screen.getAllByRole('checkbox');
  expect(cards.map(card => card.getAttribute('aria-label'))).toEqual(['Select beta.txt', 'Select alpha.txt']);
  expect(writes).not.toHaveBeenCalled();
});
