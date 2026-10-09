import { confirmDiscardDrafts, useUnsavedDraft } from './drafts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@canopy/ui';
import { ApiError, saveText, TEXT_EDIT_LIMIT } from './api';
import { latestOnly } from './reads';
import { useNavigationGuard } from './navigation-guards';

export function TextEditor({ fileId, versionId, text, wrap = true, onSaved, onCancel, onReload, onBusyChange }: {
  fileId: string; versionId: string; text: string; wrap?: boolean;
  onSaved: () => Promise<void>; onReload: () => Promise<void>; onCancel: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [draft, setDraft] = useState(text);
  const [busy, setBusy] = useState(false);
  useNavigationGuard(busy);
  useLayoutEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [saved, setSaved] = useState(false);
  useUnsavedDraft(!saved && draft !== text);
  const guard = useRef(latestOnly()).current;
  const tooLarge = draft.length > TEXT_EDIT_LIMIT;
  const canSave = !busy && !conflict && (saved || (draft !== text && !tooLarge));
  useEffect(() => () => guard.invalidate(), [guard]);
  const submit = async (reload = false) => {
    if (busy) return;
    const ticket = guard.take();
    setBusy(true); setError(null);
    try {
      if (reload) await onReload();
      else {
        // If saving succeeded but refreshing failed, retry the refresh rather than writing twice.
        if (!saved) {
          await saveText(fileId, versionId, draft);
          if (!guard.current(ticket)) return;
          setSaved(true);
        }
        await onSaved();
      }
    } catch (e: unknown) {
      if (!guard.current(ticket)) return;
      if (e instanceof ApiError && e.status === 409) {
        setConflict(true);
        setError('This file changed. Your edits are still here. Copy them before reloading the latest version.');
      } else setError(e instanceof Error ? e.message || 'Could not save text.' : String(e));
    } finally { if (guard.current(ticket)) setBusy(false); }
  };
  return <div className="space-y-3" onKeyDown={event => {
    if (event.nativeEvent.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat && canSave) void submit();
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (busy || event.repeat) return;
      if (confirmReload) setConfirmReload(false);
      else if (confirmDiscardDrafts()) onCancel();
    }
  }}>
    <label className="block text-sm">File text
      <textarea aria-label="File text" wrap={wrap ? 'soft' : 'off'} className={`mt-2 min-h-80 w-full rounded border border-border bg-background p-2 font-mono text-xs ${wrap ? 'whitespace-pre-wrap' : 'whitespace-pre overflow-x-auto'}`}
        maxLength={TEXT_EDIT_LIMIT} value={draft} readOnly={busy} disabled={saved} onChange={event => setDraft(event.target.value)} />
    </label>
    <p className="text-xs text-muted-foreground">Ctrl/⌘S to save · Esc to cancel · {draft.length.toLocaleString()} / {TEXT_EDIT_LIMIT.toLocaleString()} characters</p>
    {tooLarge ? <p role="status" className="text-sm">This text exceeds the save limit. Shorten it before saving.</p> : null}
    {error ? <p role="alert" className="text-sm">{error}</p> : null}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={!canSave} onClick={() => void submit()}>{saved ? 'Refresh saved text' : 'Save text'}</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => { if (confirmDiscardDrafts()) onCancel(); }}>Cancel editing</Button>
      {conflict ? <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmReload(true)}>Reload latest</Button> : null}
    </div>
    {confirmReload ? <div className="space-y-2 text-sm"><p>Reloading discards your unsaved edits.</p>
      <Button size="sm" disabled={busy} onClick={() => void submit(true)}>Discard edits and reload</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmReload(false)}>Keep editing</Button>
    </div> : null}
  </div>;
}
