import { useUnsavedDraft } from './drafts';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@canopy/ui';
import { ApiError, fileDetails, updateFileDetails, type FileDetails } from './api';
import { latestOnly } from './reads';
import { watchDriveChanges } from './live-updates';

/** Descriptive metadata; labels carry no access-control meaning. */
export function FileDetailsPanel({ fileId }: { fileId: string }) {
  const [details, setDetails] = useState<FileDetails | null>(null);
  const [description, setDescription] = useState('');
  const [labels, setLabels] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = !!details?.canWrite && (description !== details.description || labels !== details.labels.join('\n'));
  useUnsavedDraft(dirty);
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const state = useRef({ details, description, labels, busy, conflict });
  state.current = { details, description, labels, busy, conflict };
  const pending = useRef(false);
  const guard = useRef(latestOnly()).current;

  const accept = (got: FileDetails) => {
    setDetails(got);
    setDescription(got.description);
    setLabels(got.labels.join('\n'));
    setError(null);
    setConflict(false);
    setChangedElsewhere(false);
  };
  const load = async () => {
    const ticket = guard.take();
    setBusy(true);
    try {
      const got = await fileDetails(fileId);
      if (guard.current(ticket)) accept(got);
    } catch (e: unknown) {
      if (guard.current(ticket)) setError(e instanceof Error ? (e.message || 'Could not load details.') : String(e));
    } finally {
      if (guard.current(ticket)) setBusy(false);
    }
  };
  const refresh = async () => {
    if (state.current.busy) { pending.current = true; return; }
    const ticket = guard.take();
    try {
      const got = await fileDetails(fileId);
      if (!guard.current(ticket)) return;
      // Read the current draft after the await: typing can begin during this read.
      const current = state.current;
      const baseline = current.details;
      if (!baseline || got.revision === baseline.revision) return;
      const remoteLabels = got.labels.join('\n');
      const localDescription = current.description !== baseline.description;
      const localLabels = current.labels !== baseline.labels.join('\n');
      const overlapping = (localDescription && got.description !== baseline.description && got.description !== current.description) ||
        (localLabels && remoteLabels !== baseline.labels.join('\n') && remoteLabels !== current.labels);
      if (overlapping) { setChangedElsewhere(true); return; }
      // Rebase untouched fields and the revision while keeping independent edits.
      setDetails(got);
      setDescription(localDescription ? current.description : got.description);
      setLabels(localLabels ? current.labels : remoteLabels);
      setChangedElsewhere(false);
      setConflict(false);
      if (current.conflict) setError(null);
    } catch { /* Background nudges must not replace errors from a user action. */ }
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!busy && pending.current) {
      pending.current = false;
      void refreshRef.current();
    }
  }, [busy]);
  useEffect(() => {
    setDetails(null);
    setDescription('');
    setLabels('');
    setError(null);
    setConflict(false);
    setChangedElsewhere(false);
    pending.current = false;
    void load();
    const stop = watchDriveChanges(() => void refreshRef.current(), { entityType: 'file', entityId: fileId });
    return () => { stop(); guard.invalidate(); };
    // The guard is stable. Each file gets its own read and retires every pending answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  const save = async () => {
    if (!details || busy) return;
    const parsed = labels.split('\n').map((label) => label.trim()).filter(Boolean);
    if (parsed.length > 20 || parsed.some((label) => label.length > 100)) {
      setError('Use at most 20 labels, each at most 100 characters.');
      return;
    }
    const ticket = guard.take();
    setBusy(true);
    setError(null);
    try {
      const got = await updateFileDetails(fileId, description, parsed, details.revision);
      if (guard.current(ticket)) accept(got);
    } catch (e: unknown) {
      if (!guard.current(ticket)) return;
      setConflict(e instanceof ApiError && e.status === 409);
      setError(e instanceof Error ? (e.message || 'Could not save details.') : String(e));
    } finally {
      if (guard.current(ticket)) setBusy(false);
    }
  };

  return (
    <div className="space-y-3 text-sm">
      {error ? <p role="alert">{error}</p> : null}
      {!details ? (
        error ? <Button disabled={busy} onClick={() => void load()}>Retry</Button> : <p>Loading details…</p>
      ) : details.canWrite ? (
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label className="block space-y-1">
            <span>Description</span>
            <textarea className="w-full rounded border border-border bg-background p-2" rows={5} maxLength={10000}
              value={description} disabled={busy} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <label className="block space-y-1">
            <span>Labels</span>
            <textarea className="w-full rounded border border-border bg-background p-2" rows={3}
              aria-describedby="file-labels-help" value={labels} disabled={busy} onChange={(event) => setLabels(event.target.value)} />
          </label>
          <p id="file-labels-help" className="text-xs text-muted-foreground">One label per line, up to 20 labels. Labels do not change who has access.</p>
          <Button type="submit" disabled={busy || conflict}>{busy ? 'Saving…' : 'Save details'}</Button>
          {conflict || changedElsewhere ? (
            <div className="space-y-1">
              {changedElsewhere ? <p role="status">Details changed elsewhere. Your unsaved changes are preserved.</p> : null}
              <p className="text-xs">Reload replaces your unsaved changes with the latest details.</p>
              <Button type="button" variant="outline" disabled={busy} onClick={() => void load()}>Reload details</Button>
            </div>
          ) : null}
        </form>
      ) : (
        <>
          <p className="whitespace-pre-wrap">{details.description || 'No description.'}</p>
          {details.labels.length ? <ul className="flex flex-wrap gap-1">{details.labels.map((label) => <li key={label} className="rounded bg-muted px-2 py-1">{label}</li>)}</ul> : <p>No labels.</p>}
        </>
      )}
    </div>
  );
}
