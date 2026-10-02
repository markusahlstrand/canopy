import { useEffect } from 'react';
import { useNavigationGuard } from './navigation-guards';

const drafts = new Set<symbol>();
/** Called at boundaries that would unmount a preview editor. */
export const hasUnsavedDrafts = () => drafts.size > 0;
export function confirmDiscardDrafts(): boolean {
  return drafts.size === 0 || window.confirm('Discard unsaved changes?');
}

export function useUnsavedDraft(dirty: boolean): void {
  useNavigationGuard(dirty);
  useEffect(() => {
    if (!dirty) return;
    const id = Symbol('draft');
    drafts.add(id);
    return () => { drafts.delete(id); };
  }, [dirty]);
}
