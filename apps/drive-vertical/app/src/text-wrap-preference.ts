import { useCallback, useEffect, useState } from 'react';
export const TEXT_WRAP_KEY = 'canopy.drive.text-wrap';
function read(): boolean | null {
  try {
    let value; try { value = JSON.parse(localStorage.getItem(TEXT_WRAP_KEY) ?? 'null'); } catch (error) { if (error instanceof SyntaxError) return true; throw error; }
    if (value?.version !== undefined && value.version !== 1) return null;
    return value?.version === 1 && typeof value.wrap === 'boolean' ? value.wrap : true;
  } catch { return null; }
}
/** A browser presentation choice: no file, space, draft or account data is stored. */
export function useTextWrapPreference() {
  const [wrap, setWrap] = useState(() => read() ?? true);
  const update = useCallback((value: boolean) => {
    setWrap(value);
    try {
      let existing; try { existing = JSON.parse(localStorage.getItem(TEXT_WRAP_KEY) ?? 'null'); } catch { /* Explicit choice can replace corrupt JSON. */ }
      if (existing?.version !== undefined && existing.version !== 1) return;
      localStorage.setItem(TEXT_WRAP_KEY, JSON.stringify({ version: 1, wrap: value }));
    } catch { /* Wrapping still works for this session if storage is blocked/full. */ }
  }, []);
  useEffect(() => {
    const sync = () => { const value = read(); if (value !== null) setWrap(value); };
    const changed = (event: StorageEvent) => {
      try { if (event.storageArea !== localStorage) return; } catch { return; }
      if (event.key === null || event.key === TEXT_WRAP_KEY) sync();
    };
    window.addEventListener('storage', changed); sync();
    return () => window.removeEventListener('storage', changed);
  }, []);
  return [wrap, update] as const;
}
