import type { SortState } from './file-table';
export const VIEW_PREFERENCES_KEY = 'canopy.drive.view';
export interface ViewPreferences { layout: 'list' | 'grid'; sort: SortState }
const defaults = (): ViewPreferences => ({ layout: 'list', sort: { key: 'name', dir: 'asc' } });

/** Presentation preferences are browser-wide and contain no file or identity data. */
export function readViewPreferences(): ViewPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(VIEW_PREFERENCES_KEY) ?? 'null');
    if (value?.version !== 1) return defaults();
    return {
      layout: value.layout === 'grid' ? 'grid' : 'list',
      sort: {
        key: value.sort?.key === 'modified' ? 'modified' : 'name',
        dir: value.sort?.dir === 'desc' ? 'desc' : 'asc',
      },
    };
  } catch { return defaults(); }
}
export function saveViewPreferences(value: ViewPreferences): void {
  try { localStorage.setItem(VIEW_PREFERENCES_KEY, JSON.stringify({ version: 1, ...value })); }
  catch { /* Browsing still works with blocked or full storage. */ }
}
