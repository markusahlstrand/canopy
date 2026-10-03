import { useEffect, useRef, useState } from 'react';
import { Button } from '@canopy/ui';
import { currentSite, restoreFile } from './api';

/** Restore only the selected, loaded rows, using the existing server permission checks. */
export function BulkRestore({ files, disabled, onRestored }: {
  files: { id: string; name: string }[]; disabled: boolean; onRestored: (ids: string[]) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const restore = async () => {
    if (running.current || disabled) return;
    running.current = true; setBusy(true); setMessage(null);
    const site = currentSite();
    const selected = [...files];
    const restored: string[] = [];
    const failed: string[] = [];
    for (const file of selected) {
      try { await restoreFile(file.id, site); restored.push(file.id); }
      catch { failed.push(file.name); }
    }
    if (mounted.current) {
      setMessage(failed.length ? `Could not restore: ${failed.join(', ')}. Select these files to retry.` : `Restored ${restored.length} files.`);
      try { await onRestored(restored); }
      catch { if (mounted.current) setMessage('Restore finished, but the listing could not refresh. Refresh to check the results.'); }
      if (mounted.current) setBusy(false);
    }
    running.current = false;
  };
  if (!files.length && !message) return null;
  return <section aria-label="Restore selected files" className="mb-3 space-y-1">
    {files.length ? <Button variant="outline" size="sm" disabled={disabled || busy} onClick={() => void restore()}>{busy ? 'Restoring…' : `Restore ${files.length} selected ${files.length === 1 ? 'file' : 'files'}`}</Button> : null}
    {message ? <p role="status" className="text-sm">{message}</p> : null}
  </section>;
}
