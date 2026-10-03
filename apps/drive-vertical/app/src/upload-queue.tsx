import { useEffect, useRef, useState } from 'react';
import { Button } from '@canopy/ui';
import { useNavigationGuard } from './navigation-guards';
import { uploadFile, currentSite } from './api';

type Upload = { site: string | null; id: number; folderId: string; destination: string; name: string; file: File | null;
  state: 'queued' | 'uploading' | 'done' | 'failed' | 'cancelled'; error?: string };

/** Files keep the destination selected when queued. One upload body is in flight at a time. */
export function useUploadQueue(onChanged: () => Promise<void>) {
  const [rows, setRows] = useState<Upload[]>([]);
  const queue = useRef<Upload[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const sequence = useRef(0);
  const running = useRef(false);
  const inFlight = useRef<{ id: number; controller: AbortController } | null>(null);
  const mounted = useRef(true);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; inFlight.current?.controller.abort(); }; }, []);
  const publish = () => {
    if (!mounted.current) return;
    // A completed/cancelled batch must not leave an invisible pause behind.
    if (!queue.current.some(row => row.state === 'queued' || row.state === 'uploading')) {
      pausedRef.current = false;
      setPaused(false);
    }
    setRows([...queue.current]);
  };
  const update = (id: number, patch: Partial<Upload>) => {
    queue.current = queue.current.map(row => row.id === id ? { ...row, ...patch } : row);
    publish();
  };
  const pump = async () => {
    if (running.current) return;
    running.current = true;
    let wrote = false;
    try {
      for (;;) {
        if (!mounted.current || pausedRef.current) break;
        const row = queue.current.find(row => row.state === 'queued');
        if (!row?.file) break;
        update(row.id, { state: 'uploading', error: undefined });
        const controller = new AbortController();
        inFlight.current = { id: row.id, controller };
        try {
          await uploadFile(row.folderId, row.file, row.site, controller.signal);
          wrote = true;
          update(row.id, { state: 'done', file: null });
        } catch (e: unknown) {
          if (controller.signal.aborted) {
            update(row.id, { state: 'cancelled', file: null, error: undefined });
            // Aborting transfer cannot undo bytes the server already received. Re-read.
            wrote = true;
          } else update(row.id, { state: 'failed', error: e instanceof Error ? e.message || 'Upload failed.' : String(e) });
          continue;
        } finally {
          inFlight.current = null;
        }
      }
    } finally {
      running.current = false;
      if (wrote && mounted.current) await changed.current().catch(() => {});
    }
  };
  const enqueue = (folderId: string, destination: string, files: File[]) => {
    queue.current.push(...files.map(file => ({ site: currentSite(), id: ++sequence.current, folderId, destination, name: file.name, file, state: 'queued' as const })));
    publish();
    void pump();
  };
  const cancel = (id?: number) => {
    queue.current = queue.current.map(row => (row.state === 'queued' || (id !== undefined && row.state === 'uploading')) && (id === undefined || row.id === id)
      ? { ...row, state: 'cancelled', file: null, error: undefined } : row);
    if (id !== undefined && inFlight.current?.id === id) inFlight.current.controller.abort();
    publish();
  };
  const active = rows.some(row => row.state === 'queued' || row.state === 'uploading');
  useNavigationGuard(active);
  const panel = rows.length ? <section aria-label="Uploads" className="max-h-48 shrink-0 overflow-auto border-b border-border px-4 py-2 text-sm">
    {rows.some(row => row.state === 'queued') || paused ? <Button size="sm" variant="outline" onClick={() => {
      pausedRef.current = !pausedRef.current;
      setPaused(pausedRef.current);
      if (!pausedRef.current) void pump();
    }}>{paused ? 'Resume uploads' : 'Pause uploads'}</Button> : null}
    {paused ? <p className="text-xs text-muted-foreground">Uploads paused. The current transfer finishes; waiting and retried files start when you choose Resume uploads.</p> : null}
    <p role="status">{rows.filter(row => row.state === 'done').length} of {rows.length} uploaded{rows.some(row => row.state === 'cancelled') ? ` · ${rows.filter(row => row.state === 'cancelled').length} cancelled` : ''}</p>
    {rows.some(row => row.state === 'failed' && row.file) ? <Button size="sm" variant="outline" onClick={() => {
      queue.current = queue.current.map(row => row.state === 'failed' && row.file ? { ...row, state: 'queued', error: undefined } : row);
      publish(); void pump();
    }}>Retry failed uploads</Button> : null}
    {rows.some(row => row.state === 'queued') ? <Button size="sm" variant="outline" onClick={() => cancel()}>Cancel queued uploads</Button> : null}
    {rows.some(row => row.state === 'done' || row.state === 'cancelled') ? <Button size="sm" variant="ghost" onClick={() => {
      queue.current = queue.current.filter(row => row.state !== 'done' && row.state !== 'cancelled'); publish();
    }}>Clear completed uploads</Button> : null}
    <ul>{rows.map(row => <li key={row.id} className="flex flex-wrap items-center gap-2 py-1">
      <span>{row.name}</span><span className="text-xs text-muted-foreground">to {row.destination}</span>
      <span>{row.state === 'done' ? 'Uploaded' : row.state === 'failed' ? 'Failed' : row.state === 'uploading' ? 'Uploading…' : row.state === 'cancelled' ? 'Cancelled' : 'Queued'}</span>
      {row.state === 'queued' || row.state === 'uploading' ? <Button size="sm" variant="outline" onClick={() => cancel(row.id)}>Cancel {row.name}</Button> : null}
      {row.error ? <span role="alert">{row.error}</span> : null}
      {row.state === 'failed' ? <Button size="sm" variant="outline" onClick={() => { update(row.id, { state: 'queued' }); void pump(); }}>Retry {row.name}</Button> : null}
      {row.state === 'done' || row.state === 'failed' || row.state === 'cancelled' ? <Button size="sm" variant="ghost" aria-label={`Dismiss ${row.name}`} onClick={() => {
        queue.current = queue.current.filter(item => item.id !== row.id); publish();
      }}>Dismiss</Button> : null}
    </li>)}</ul>
    {rows.some(row => row.state === 'cancelled') ? <p className="text-xs text-muted-foreground">Stopping a transfer cannot undo an upload the server already received. Check the folder after it refreshes.</p> : null}
    {rows.some(row => row.state === 'failed') ? <p className="text-xs text-muted-foreground">Retry uploads the file again and may create another version if the first request completed.</p> : null}
  </section> : null;
  return { enqueue, panel };
}
