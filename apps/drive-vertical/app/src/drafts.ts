import { useEffect } from 'react';

const drafts = new Set<symbol>();
/** Called at boundaries that would unmount a preview editor. */
export function confirmDiscardDrafts(): boolean {
  return drafts.size === 0 || window.confirm('Discard unsaved changes?');
}

export function useUnsavedDraft(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const id = Symbol('draft');
    drafts.add(id);
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { drafts.delete(id); window.removeEventListener('beforeunload', beforeUnload); };
  }, [dirty]);
}
