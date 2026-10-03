import { afterEach, expect, it, vi } from 'vitest';
import { readViewPreferences, saveViewPreferences, VIEW_PREFERENCES_KEY } from './view-preferences';
afterEach(() => { vi.restoreAllMocks(); localStorage.removeItem(VIEW_PREFERENCES_KEY); });
it('round-trips supported layout and sort preferences', () => {
  saveViewPreferences({ layout: 'grid', sort: { key: 'modified', dir: 'desc' } });
  expect(readViewPreferences()).toEqual({ layout: 'grid', sort: { key: 'modified', dir: 'desc' } });
});
it('uses safe defaults for corrupted, outdated or unknown values', () => {
  for (const value of ['bad JSON', JSON.stringify({ version: 9, layout: 'grid' }), JSON.stringify({ version: 1, layout: 'tiles', sort: { key: 'size', dir: 'other' } })]) {
    localStorage.setItem(VIEW_PREFERENCES_KEY, value);
    expect(readViewPreferences()).toEqual({ layout: 'list', sort: { key: 'name', dir: 'asc' } });
  }
});
it('does not break browsing when storage is denied', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(readViewPreferences().layout).toBe('list');
  expect(() => saveViewPreferences({ layout: 'grid', sort: { key: 'name', dir: 'desc' } })).not.toThrow();
});

it('leaves newer-format preferences alone even after an explicit old-client change', () => {
  const newer = JSON.stringify({ version: 2, layout: 'grid', extra: 'new preference' });
  localStorage.setItem(VIEW_PREFERENCES_KEY, newer);
  saveViewPreferences({ layout: 'list', sort: { key: 'name', dir: 'asc' } });
  expect(localStorage.getItem(VIEW_PREFERENCES_KEY)).toBe(newer);
});
