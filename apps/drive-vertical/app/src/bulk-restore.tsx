import { useEffect, useRef, useState } from 'react';
import { Button } from '@canopy/ui';
import { ApiError, currentSite, restoreFile } from './api';

const filesLabel = (count: number) => `${count} ${count === 1 ? 'file' : 'files'}`;

/** Keep this mounted across views so one batch retains its progress and outcome. */
export function BulkRestore({ files, disabled, visible = true, onRestored }: {
  files: { id: string; name: string }[]; disabled: boolean; visible?: boolean; onRestored: (ids: string[]) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ attempted: 0, total: 0 });
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancelled.current = true; }; }, []);
  const restore = async () => {
    if (running.current || disabled || !visible) return;
    running.current = true; cancelled.current = false; setBusy(true); setMessage(null);
    const site = currentSite();
    const selected = [...files];
    setProgress({ attempted: 0, total: selected.length });
    const restored: string[] = [];
    const denied: string[] = [];
    const retryable: string[] = [];
    const unavailable: string[] = [];
    let attempted = 0;
    let stopped: 'session' | 'connection' | null = null;
    for (const file of selected) {
      if (cancelled.current) break;
      try { await restoreFile(file.id, site); restored.push(file.id); }
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
      const parts = [`Restored ${filesLabel(restored.length)}.`];
      if (denied.length) parts.push(`No permission to restore ${filesLabel(denied.length)}: ${denied.join(', ')}.`);
      if (unavailable.length) parts.push(`Could not restore ${filesLabel(unavailable.length)}: ${unavailable.join(', ')}. Refresh to check availability.`);
      if (retryable.length) parts.push(`Could not restore ${filesLabel(retryable.length)}: ${retryable.join(', ')}. Retry these files.`);
      if (stopped === 'session') parts.push(`Your session expired. Sign in before retrying. ${filesLabel(remaining)} ${remaining === 1 ? 'was' : 'were'} not attempted.`);
      else if (stopped === 'connection') parts.push(`Connection lost. Reconnect before retrying. ${filesLabel(remaining)} ${remaining === 1 ? 'was' : 'were'} not attempted.`);
      else if (cancelled.current && remaining) parts.push(`Stopped. ${filesLabel(remaining)} ${remaining === 1 ? 'was' : 'were'} not attempted.`);
      setMessage(parts.join(' '));
      try { await onRestored(restored); }
      catch { if (mounted.current) setMessage(parts.join(' ') + ' The listing could not refresh. Refresh to check the results.'); }
      if (mounted.current) setBusy(false);
    }
    running.current = false;
  };
  if (!busy && !message && (!visible || !files.length)) return null;
  return <section aria-label="Restore selected files" className="mb-3 space-y-1">
    {busy ? <><p role="status" className="text-sm">Restoring {progress.attempted} of {progress.total}…</p>
      <Button variant="outline" size="sm" onClick={() => { cancelled.current = true; }}>Cancel remaining restores</Button></>
      : visible && files.length ? <Button variant="outline" size="sm" disabled={disabled} onClick={() => void restore()}>Restore {files.length} selected {files.length === 1 ? 'file' : 'files'}</Button> : null}
    {message ? <p role="status" className="text-sm">{message}</p> : null}
  </section>;
}
