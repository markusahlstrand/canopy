import { useLayoutEffect } from 'react';
import { useNavigationGuard } from './navigation-guards';

const drafts = new Set<symbol>();
/** Called at boundaries that would unmount a preview editor. */
export const hasUnsavedDrafts = () => drafts.size > 0;
export function confirmDiscardDrafts(): boolean {
  return drafts.size === 0 || window.confirm('Discard unsaved changes?');
}

export function useUnsavedDraft(dirty: boolean): void {
  useNavigationGuard(dirty);
  // Clear saved/unmounted drafts during commit. A passive cleanup can run after
  // the next click and incorrectly refuse navigation from an already saved editor.
  useLayoutEffect(() => {
    if (!dirty) return;
    const id = Symbol('draft');
    drafts.add(id);
    return () => { drafts.delete(id); };
  }, [dirty]);
}
