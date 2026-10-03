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
  try {
    let existing;
    try { existing = JSON.parse(localStorage.getItem(VIEW_PREFERENCES_KEY) ?? 'null'); } catch { /* Replace corrupt JSON only after an explicit change. */ }
    if (existing?.version !== undefined && existing.version !== 1) return;
    localStorage.setItem(VIEW_PREFERENCES_KEY, JSON.stringify({ version: 1, ...value }));
  }
  catch { /* Browsing still works with blocked or full storage. */ }
}

/** Follow other same-origin tabs without echoing their writes back to storage. */
export function watchViewPreferences(onChange: (value: ViewPreferences) => void): () => void {
  const sync = () => {
    try {
      let stored;
      try { stored = JSON.parse(localStorage.getItem(VIEW_PREFERENCES_KEY) ?? 'null'); }
      catch (error) {
        if (!(error instanceof SyntaxError)) return; // Storage itself may be blocked.
      }
      // A newer client owns this record. Keep the current view until it is cleared
      // or replaced with a supported version, just as save preserves that record.
      if (stored?.version !== undefined && stored.version !== 1) return;
      onChange(readViewPreferences());
    } catch { /* Storage can be denied independently of normal browsing. */ }
  };
  const changed = (event: StorageEvent) => {
    try { if (event.storageArea !== localStorage) return; } catch { return; }
    if (event.key !== null && event.key !== VIEW_PREFERENCES_KEY) return;
    // Queued events may describe an older write; read the value that exists now.
    sync();
  };
  window.addEventListener('storage', changed);
  sync();
  return () => window.removeEventListener('storage', changed);
}
