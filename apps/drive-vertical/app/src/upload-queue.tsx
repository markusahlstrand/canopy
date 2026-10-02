import { useEffect, useRef, useState } from 'react';
import { Button } from '@canopy/ui';
import { uploadFile } from './api';

type Upload = { id: number; folderId: string; destination: string; name: string; file: File | null;
  state: 'queued' | 'uploading' | 'done' | 'failed'; error?: string };

/** Files keep the destination selected when queued. One upload body is in flight at a time. */
export function useUploadQueue(onChanged: () => Promise<void>) {
  const [rows, setRows] = useState<Upload[]>([]);
  const queue = useRef<Upload[]>([]);
  const sequence = useRef(0);
  const running = useRef(false);
  const mounted = useRef(true);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const publish = () => { if (mounted.current) setRows([...queue.current]); };
  const update = (id: number, patch: Partial<Upload>) => {
    queue.current = queue.current.map(row => row.id === id ? { ...row, ...patch } : row);
    publish();
  };
  const pump = async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (;;) {
        if (!mounted.current) break;
        const row = queue.current.find(row => row.state === 'queued');
        if (!row?.file) break;
        update(row.id, { state: 'uploading', error: undefined });
        try {
          await uploadFile(row.folderId, row.file);
          update(row.id, { state: 'done', file: null });
        } catch (e: unknown) {
          update(row.id, { state: 'failed', error: e instanceof Error ? e.message || 'Upload failed.' : String(e) });
          continue;
        }
        if (mounted.current) await changed.current().catch(() => {});
      }
    } finally { running.current = false; }
  };
  const enqueue = (folderId: string, destination: string, files: File[]) => {
    queue.current.push(...files.map(file => ({ id: ++sequence.current, folderId, destination, name: file.name, file, state: 'queued' as const })));
    publish();
    void pump();
  };
  const active = rows.some(row => row.state === 'queued' || row.state === 'uploading');
  useEffect(() => {
    if (!active) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [active]);
  const panel = rows.length ? <section aria-label="Uploads" className="max-h-48 shrink-0 overflow-auto border-b border-border px-4 py-2 text-sm">
    <p role="status">{rows.filter(row => row.state === 'done').length} of {rows.length} uploaded</p>
    <ul>{rows.map(row => <li key={row.id} className="flex flex-wrap items-center gap-2 py-1">
      <span>{row.name}</span><span className="text-xs text-muted-foreground">to {row.destination}</span>
      <span>{row.state === 'done' ? 'Uploaded' : row.state === 'failed' ? 'Failed' : row.state === 'uploading' ? 'Uploading…' : 'Queued'}</span>
      {row.error ? <span role="alert">{row.error}</span> : null}
      {row.state === 'failed' ? <Button size="sm" variant="outline" onClick={() => { update(row.id, { state: 'queued' }); void pump(); }}>Retry {row.name}</Button> : null}
      {row.state === 'done' || row.state === 'failed' ? <Button size="sm" variant="ghost" aria-label={`Dismiss ${row.name}`} onClick={() => {
        queue.current = queue.current.filter(item => item.id !== row.id); publish();
      }}>Dismiss</Button> : null}
    </li>)}</ul>
    {rows.some(row => row.state === 'failed') ? <p className="text-xs text-muted-foreground">Retry uploads the file again and may create another version if the first request completed.</p> : null}
  </section> : null;
  return { enqueue, panel };
}
