import { useEffect, useRef, useState } from 'react';
import { Button, Icon } from '@canopy/ui';
import { FileIcon } from './file-icon';
import { kindForName } from './items';
import { useNavigationGuard } from './navigation-guards';
import { uploadFile, currentSite } from './api';

type Upload = { site: string | null; id: number; folderId: string; destination: string; name: string; file: File | null;
  state: 'queued' | 'uploading' | 'done' | 'failed' | 'cancelled'; error?: string };

/** Files keep the destination selected when queued. One upload body is in flight at a time. */
export function useUploadQueue(onChanged: () => Promise<void>) {
  const [rows, setRows] = useState<Upload[]>([]);
  const queue = useRef<Upload[]>([]);
  const [paused, setPaused] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const pausedRef = useRef(false);
  const sequence = useRef(0);
  // Bumped whenever work is added — queued or retried — so the guard drops a stale approval.
  const [work, setWork] = useState(0);
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
    setWork(n => n + 1);
    // New files reopen a collapsed tray, like a fresh notification.
    setCollapsed(false);
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
  useNavigationGuard(active, work);
  const closeAll = () => {
    inFlight.current?.controller.abort();
    queue.current = [];
    setConfirmClose(false);
    publish();
  };
  const count = (state: Upload['state']) => rows.filter(row => row.state === state).length;
  const pending = count('queued') + count('uploading');
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const title = pending ? `Uploading ${plural(pending, 'item')}`
    : count('failed') ? `${plural(count('failed'), 'upload')} failed`
    : `${plural(count('done'), 'upload')} complete`;
  const rowAction = 'size-7 text-muted-foreground md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100';
  const panel = rows.length ? <section aria-label="Uploads"
    className="fixed inset-x-3 bottom-3 z-40 flex max-h-[min(28rem,70vh)] flex-col overflow-hidden rounded-xl border border-border bg-popover text-sm text-popover-foreground shadow-lg md:inset-x-auto md:bottom-6 md:right-6 md:w-[22rem]">
    <header className="flex shrink-0 items-center gap-1 bg-muted/60 py-1.5 pl-4 pr-1.5">
      <div className="min-w-0 flex-1">
        <h2 className="truncate font-medium">{title}</h2>
        <p role="status" className="truncate text-xs text-muted-foreground">{count('done')} of {rows.length} uploaded{count('cancelled') ? ` · ${count('cancelled')} cancelled` : ''}</p>
      </div>
      <Button size="icon" variant="ghost" className="size-8" aria-expanded={!collapsed} aria-label={collapsed ? 'Expand uploads' : 'Collapse uploads'} onClick={() => setCollapsed(c => !c)}>
        <Icon name="chevron-down" size={16} className={collapsed ? 'rotate-180 transition-transform' : 'transition-transform'} />
      </Button>
      <Button size="icon" variant="ghost" className="size-8" aria-label="Close uploads" onClick={() => active ? (setCollapsed(false), setConfirmClose(true)) : closeAll()}>
        <Icon name="x" size={16} />
      </Button>
    </header>
    {confirmClose && active ? <div className="space-y-3 border-t border-border p-4">
      <p>Cancel {plural(pending, 'upload')} still in progress?</p>
      <p className="text-xs text-muted-foreground">A file the server already received stays in the folder.</p>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setConfirmClose(false)}>Keep uploading</Button>
        <Button size="sm" variant="destructive" onClick={closeAll}>Cancel uploads</Button>
      </div>
    </div> : collapsed ? null : <>
      {count('queued') || paused || rows.some(row => row.state === 'failed' && row.file) || count('done') || count('cancelled')
        ? <div className="flex shrink-0 flex-wrap items-center gap-1 border-t border-border px-2 py-1">
          {count('queued') || paused ? <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" aria-label={paused ? 'Resume uploads' : 'Pause uploads'} onClick={() => {
            pausedRef.current = !pausedRef.current;
            setPaused(pausedRef.current);
            if (!pausedRef.current) void pump();
          }}>{paused ? 'Resume' : 'Pause'}</Button> : null}
          {count('queued') ? <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" aria-label="Cancel queued uploads" onClick={() => cancel()}>Cancel waiting</Button> : null}
          {rows.some(row => row.state === 'failed' && row.file) ? <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" aria-label="Retry failed uploads" onClick={() => {
            queue.current = queue.current.map(row => row.state === 'failed' && row.file ? { ...row, state: 'queued', error: undefined } : row);
            setWork(n => n + 1);
            publish(); void pump();
          }}>Retry failed</Button> : null}
          {count('done') || count('cancelled') ? <Button size="sm" variant="ghost" className="ml-auto h-7 px-2 text-xs" aria-label="Clear completed uploads" onClick={() => {
            queue.current = queue.current.filter(row => row.state !== 'done' && row.state !== 'cancelled'); publish();
          }}>Clear finished</Button> : null}
        </div> : null}
      {paused ? <p className="shrink-0 border-t border-border px-4 py-2 text-xs text-muted-foreground">Uploads paused. The current transfer finishes; waiting and retried files start when you choose Resume uploads.</p> : null}
      <ul className="min-h-0 flex-1 overflow-auto border-t border-border py-1">{rows.map(row => <li key={row.id} className="group flex items-center gap-3 px-4 py-1.5 hover:bg-accent/50">
        <FileIcon kind={kindForName(row.name)} size={24} />
        <div className="min-w-0 flex-1">
          <p className="truncate" title={row.name}>{row.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            <span className={row.state === 'failed' ? 'text-destructive' : undefined}>{row.state === 'done' ? 'Uploaded' : row.state === 'failed' ? 'Failed' : row.state === 'uploading' ? 'Uploading…' : row.state === 'cancelled' ? 'Cancelled' : 'Queued'}</span>
            {' · to '}{row.destination}
          </p>
          {row.error ? <p role="alert" className="text-xs text-destructive">{row.error}</p> : null}
        </div>
        {row.state === 'uploading' ? <span aria-hidden className="size-4 shrink-0 animate-spin rounded-full border-2 border-muted border-t-primary" /> : null}
        {row.state === 'done' ? <Icon name="circle-check" size={18} className="shrink-0 text-green-600" /> : null}
        {row.state === 'failed' ? <Icon name="alert-triangle" size={18} className="shrink-0 text-destructive" /> : null}
        {row.state === 'queued' || row.state === 'uploading' ? <Button size="icon" variant="ghost" className={rowAction} aria-label={`Cancel ${row.name}`} title="Cancel" onClick={() => cancel(row.id)}><Icon name="x" size={14} /></Button> : null}
        {row.state === 'failed' ? <Button size="icon" variant="ghost" className={rowAction} aria-label={`Retry ${row.name}`} title="Retry. May create another version if the first request completed." onClick={() => { update(row.id, { state: 'queued' }); void pump(); }}><Icon name="refresh" size={14} /></Button> : null}
        {row.state === 'done' || row.state === 'failed' || row.state === 'cancelled' ? <Button size="icon" variant="ghost" className={rowAction} aria-label={`Dismiss ${row.name}`} title="Dismiss" onClick={() => {
          queue.current = queue.current.filter(item => item.id !== row.id); publish();
        }}><Icon name="x" size={14} /></Button> : null}
      </li>)}</ul>
      {count('cancelled') ? <p className="shrink-0 border-t border-border px-4 py-2 text-xs text-muted-foreground">Stopping a transfer cannot undo an upload the server already received. Check the folder after it refreshes.</p> : null}
    </>}
  </section> : null;
  return { enqueue, panel };
}
