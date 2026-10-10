import { useLayoutEffect } from 'react';
import { useNavigationGuard } from './navigation-guards';

const drafts = new Set<symbol>();
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };
/** Called at boundaries that would unmount a preview editor. */
export const hasUnsavedDrafts = () => drafts.size > 0;
/** For `useSyncExternalStore`: whatever held still for a draft can retry once it clears. */
export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
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
    changed();
    return () => { drafts.delete(id); changed(); };
  }, [dirty]);
}
