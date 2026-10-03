import { useEffect, useRef, useState } from 'react';
import { Button } from '@canopy/ui';
import { ApiError, currentSite, trashFile } from './api';
import { useNavigationGuard } from './navigation-guards';
import { confirmDiscardDrafts } from './drafts';

const filesLabel = (count: number) => `${count} ${count === 1 ? 'file' : 'files'}`;

/** Keep this mounted across views so one batch retains its progress and outcome. */
export function BulkTrash({ files, disabled, visible = true, onTrashed }: {
  files: { id: string; name: string }[]; disabled: boolean; visible?: boolean; onTrashed: (ids: string[]) => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState<{ files: { id: string; name: string }[]; site: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ attempted: 0, total: 0 });
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancelled.current = true; }; }, []);
  useNavigationGuard(busy);
  const trash = async () => {
    if (running.current || disabled || !confirmation || !confirmDiscardDrafts()) return;
    running.current = true; cancelled.current = false; setBusy(true); setMessage(null);
    const { site, files: selected } = confirmation;
    setConfirmation(null);
    setProgress({ attempted: 0, total: selected.length });
    const trashed: string[] = [];
    const denied: string[] = [];
    const retryable: string[] = [];
    const unavailable: string[] = [];
    let attempted = 0;
    let stopped: 'session' | 'connection' | null = null;
    for (const file of selected) {
      if (cancelled.current) break;
      try { await trashFile(file.id, site); trashed.push(file.id); }
      catch (error) {
        if (error instanceof ApiError && error.status === 401) stopped = 'session';
        else if (error instanceof TypeError) stopped = 'connection';
        else if (error instanceof ApiError && error.status === 403) denied.push(file.name);
        else if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) unavailable.push(file.name);
        else retryable.push(file.name);
      }
      attempted++;
      if (mounted.current) setProgress({ attempted, total: selected.length });
      if (stopped) break;
    }
    if (mounted.current) {
      const remaining = selected.length - attempted;
      const parts = [`Moved to Trash: ${filesLabel(trashed.length)}.`];
      if (denied.length) parts.push(`No permission to trash ${filesLabel(denied.length)}: ${denied.join(', ')}.`);
      if (unavailable.length) parts.push(`Could not trash ${filesLabel(unavailable.length)}: ${unavailable.join(', ')}. Refresh to check availability.`);
      if (retryable.length) parts.push(`Could not trash ${filesLabel(retryable.length)}: ${retryable.join(', ')}. Retry these files.`);
      if (stopped === 'session') parts.push(`Your session expired. Sign in before retrying. ${filesLabel(remaining)} ${remaining === 1 ? 'was' : 'were'} not attempted.`);
      else if (stopped === 'connection') parts.push(`Connection lost. Reconnect before retrying. ${filesLabel(remaining)} ${remaining === 1 ? 'was' : 'were'} not attempted.`);
      else if (cancelled.current && remaining) parts.push(`Stopped. ${filesLabel(remaining)} ${remaining === 1 ? 'was' : 'were'} not attempted.`);
      setMessage(parts.join(' '));
      try { await onTrashed(trashed); }
      catch { if (mounted.current) setMessage(parts.join(' ') + ' The listing could not refresh. Refresh to check the results.'); }
      if (mounted.current) setBusy(false);
    }
    running.current = false;
  };
  if (!busy && !confirmation && !message && (!visible || !files.length)) return null;
  return <section aria-label="Move selected files to Trash" className="mb-3 space-y-1">
    {busy ? <><p role="status" className="text-sm">Moving to Trash: {progress.attempted} of {progress.total}…</p>
      <Button variant="outline" size="sm" onClick={() => { cancelled.current = true; }}>Cancel remaining moves</Button></>
       : confirmation ? <div role="group" aria-label="Confirm move to Trash" className="space-y-2">
        <p>Move these {filesLabel(confirmation.files.length)} to Trash? You can restore them later. Folders are excluded.</p>
        <ul className="max-h-40 overflow-auto">{confirmation.files.map(file => <li key={file.id}>{file.name}</li>)}</ul>
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => void trash()}>Confirm move to Trash</Button>{' '}
        <Button variant="outline" size="sm" onClick={() => setConfirmation(null)}>Cancel</Button>
      </div> : visible && files.length ? <Button variant="outline" size="sm" disabled={disabled} onClick={() => {
        if (!running.current && !disabled) { setMessage(null); setConfirmation({ files: files.map(file => ({ ...file })), site: currentSite() }); }
      }}>Move {files.length} selected {files.length === 1 ? 'file' : 'files'} to Trash</Button> : null}
    {message ? <p role="status" className="text-sm">{message}</p> : null}
  </section>;
}
