import { useLayoutEffect } from 'react';

const pending = new Set<symbol>();
let approved = false;
/** Any edit after an approval is work the user has not agreed to lose. */
const EDITS = ['input', 'change', 'paste', 'drop'] as const;
function revoke() {
  approved = false;
  for (const type of EDITS) document.removeEventListener(type, revoke, true);
}
function approve() {
  approved = true;
  for (const type of EDITS) document.addEventListener(type, revoke, true);
}

/**
 * Confirm before mutating space selection or signing out, rather than at browser unload.
 * An approval stands only until the pending work changes — a new draft or upload, or an
 * edit to one already open — so a re-check asks about new work and nothing else.
 */
export function confirmNavigation(): boolean {
  if (pending.size && !approved && !window.confirm('Leave this space? Unsaved changes and queued uploads will be lost.')) return false;
  approve();
  return true;
}

/** Browser exit protection shared by draft editors and the upload queue. */
export function useNavigationGuard(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return;
    const id = Symbol('pending work');
    pending.add(id);
    revoke();
    const protect = (event: BeforeUnloadEvent) => {
      if (!approved) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', protect);
    return () => { pending.delete(id); revoke(); window.removeEventListener('beforeunload', protect); };
  }, [active]);
}
