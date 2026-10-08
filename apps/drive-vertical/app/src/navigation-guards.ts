import { useLayoutEffect } from 'react';

const pending = new Set<symbol>();
let approved = false;
/** Confirm before mutating space selection or signing out, rather than at browser unload. */
export function confirmNavigation(): boolean {
  if (pending.size && !window.confirm('Leave this space? Unsaved changes and queued uploads will be lost.')) return false;
  approved = true;
  return true;
}

/** Browser exit protection shared by draft editors and the upload queue. */
export function useNavigationGuard(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return;
    const id = Symbol('pending work');
    pending.add(id);
    approved = false;
    const protect = (event: BeforeUnloadEvent) => {
      if (!approved) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', protect);
    return () => { pending.delete(id); approved = false; window.removeEventListener('beforeunload', protect); };
  }, [active]);
}
