import { confirmDiscardDrafts, useUnsavedDraft } from './drafts';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@canopy/ui';
import { ApiError, saveText, TEXT_PREVIEW_LIMIT } from './api';
import { latestOnly } from './reads';

export function TextEditor({ fileId, versionId, text, onSaved, onCancel, onReload }: {
  fileId: string; versionId: string; text: string;
  onSaved: () => Promise<void>; onReload: () => Promise<void>; onCancel: () => void;
}) {
  const [draft, setDraft] = useState(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [saved, setSaved] = useState(false);
  useUnsavedDraft(!saved && draft !== text);
  const guard = useRef(latestOnly()).current;
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
  return <div className="space-y-3">
    <label className="block text-sm">File text
      <textarea aria-label="File text" className="mt-2 min-h-80 w-full rounded border border-border bg-background p-2 font-mono text-xs"
        maxLength={TEXT_PREVIEW_LIMIT} value={draft} disabled={busy || saved} onChange={event => setDraft(event.target.value)} />
    </label>
    {error ? <p role="alert" className="text-sm">{error}</p> : null}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={busy || conflict || (!saved && draft === text)} onClick={() => void submit()}>{saved ? 'Refresh saved text' : 'Save text'}</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => { if (confirmDiscardDrafts()) onCancel(); }}>Cancel editing</Button>
      {conflict ? <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmReload(true)}>Reload latest</Button> : null}
    </div>
    {confirmReload ? <div className="space-y-2 text-sm"><p>Reloading discards your unsaved edits.</p>
      <Button size="sm" disabled={busy} onClick={() => void submit(true)}>Discard edits and reload</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmReload(false)}>Keep editing</Button>
    </div> : null}
  </div>;
}
