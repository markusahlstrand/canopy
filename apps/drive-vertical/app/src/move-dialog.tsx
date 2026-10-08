import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@canopy/ui';
import { ApiError, currentSite, listFoldersPage, appendRows, moveFile, moveFolder, ROOT_FOLDER_ID, type DriveFolder } from './api';
import { latestOnly } from './reads';
import { useNavigationGuard } from './navigation-guards';
import type { FileItem } from './items';

/** Same-space destinations; the server checks source and destination permissions. */
export function MoveDialog({ items, sourceFolderId, onClose, onMoved }: {
  items: FileItem[];
  sourceFolderId: string | null;
  onClose: () => void;
  onMoved: (ids: string[]) => Promise<void>;
}) {
  const [site] = useState(currentSite);
  const mounted = useRef(true);
  const running = useRef(false);
  const cancelled = useRef(false);
  const completed = useRef(new Set<string>());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancelled.current = true; }; }, []);
  const reads = useRef(latestOnly()).current;
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [trail, setTrail] = useState([{ id: ROOT_FOLDER_ID, name: 'My Drive' }]);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [foldersFailed, setFoldersFailed] = useState(false);
  const [folderRetry, setFolderRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(items);
  const [failures, setFailures] = useState<{ id: string; message: string }[]>([]);
  useNavigationGuard(busy);
  const destination = trail[trail.length - 1]!;

  useEffect(() => {
    const ticket = reads.take();
    setNext(null);
    setLoadingMore(false);
    setLoading(true);
    setFoldersFailed(false);
    setFolders([]);
    setError(null);
    listFoldersPage(destination.id, null, site).then((answer) => {
      if (reads.current(ticket)) { setFolders(answer.entries); setNext(answer.next); }
    }).catch((e: unknown) => {
      if (reads.current(ticket)) { setFoldersFailed(true); setError(e instanceof Error ? e.message : String(e)); }
    }).finally(() => {
      if (reads.current(ticket)) setLoading(false);
    });
    return () => reads.invalidate();
  }, [destination.id, folderRetry]);

  const more = async () => {
    if (!next || loadingMore || loading || busy) return;
    const ticket = reads.take();
    setLoadingMore(true);
    setError(null);
    try {
      const page = await listFoldersPage(destination.id, next, site);
      if (reads.current(ticket)) { setFolders(rows => appendRows(rows, page.entries)); setNext(page.next); }
    } catch (e: unknown) {
      if (reads.current(ticket)) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (reads.current(ticket)) setLoadingMore(false);
    }
  };

  const blocked = (folder: DriveFolder) => items.some((item) => item.isFolder && (
    folder.id === item.id || folder.path.startsWith(`${item.path}/`)
  ));

  const changeDestination = (nextTrail: typeof trail) => {
    if (busy || nextTrail[nextTrail.length - 1]!.id === destination.id) return;
    setTrail(nextTrail);
    setRemaining(items.filter(item => !completed.current.has(item.id)));
    setFailures([]);
  };

  const submit = async () => {
    if (running.current || loading || foldersFailed || !remaining.length || destination.id === sourceFolderId) return;
    running.current = true; cancelled.current = false; setBusy(true); setError(null);
    let left = remaining;
    const moved: string[] = [];
    const problems = failures.filter(failure => !remaining.some(item => item.id === failure.id));
    let attempted = 0;
    let stopped: string | null = null;
    for (const item of remaining) {
      if (!mounted.current || cancelled.current) break;
      try {
        if (item.isFolder) await moveFolder(item.id, destination.id, site);
        else await moveFile(item.id, destination.id, site);
        moved.push(item.id); completed.current.add(item.id);
        left = left.filter(candidate => candidate.id !== item.id);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) stopped = 'Your session expired. Sign in before retrying.';
        else if (error instanceof TypeError) stopped = 'Connection lost. Reconnect before retrying.';
        else {
          const permanent = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429;
          const reason = error instanceof ApiError && error.status === 403
            ? `No permission to move ${item.name} into ${destination.name}. Check source and destination access or choose another folder.`
            : error instanceof ApiError && error.status === 409 ? `${item.name}: name collision in ${destination.name}. Choose another folder or rename the file.`
            : `${item.name}: ${error instanceof Error ? error.message : String(error)}.${permanent ? ' Check availability.' : ' Retry this file.'}`;
          problems.push({ id: item.id, message: reason });
          if (permanent) left = left.filter(candidate => candidate.id !== item.id);
        }
      }
      attempted++;
      if (mounted.current) setRemaining(left);
      if (stopped) break;
    }
    if (mounted.current) {
      let refreshFailed = false;
      try { await onMoved(moved); } catch { refreshFailed = true; }
      if (mounted.current) {
        setFailures(problems);
        if (!problems.length && !stopped && !left.length && !refreshFailed) onClose();
        else {
          const unattempted = remaining.length - attempted;
          setError(`${completed.current.size} moved; ${left.length} remaining to retry. ${unattempted} not attempted. ${stopped ?? (cancelled.current ? 'Stopped.' : '')} ${refreshFailed ? 'The listing could not refresh. Refresh to check the results.' : ''}`);
        }
        setBusy(false);
      }
    }
    running.current = false;
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move {items.length === 1 ? items[0]!.name : `${items.length} items`}</DialogTitle>
          <DialogDescription>Choose a folder in this space. Access follows the destination; existing names are refused.</DialogDescription>
        </DialogHeader>
        <ul aria-label="Files remaining to move" className="max-h-32 overflow-auto text-sm">{remaining.map(item => <li key={item.id}>{item.name}</li>)}</ul>
        {busy ? <p role="status">Moved {completed.current.size} of {items.length}…</p> : null}
        <nav aria-label="Destination path" className="flex flex-wrap gap-2">
          {trail.map((crumb, index) => (
            <Button key={crumb.id} variant="ghost" size="sm" disabled={busy}
              onClick={() => changeDestination(trail.slice(0, index + 1))}>{crumb.name}</Button>
          ))}
        </nav>
        <div aria-label="Destination folders" className="max-h-64 overflow-auto">
          {loading ? <p role="status">Loading folders…</p> : folders.map((folder) => (
            <Button key={folder.id} variant="ghost" className="w-full justify-start"
              disabled={busy || blocked(folder)}
              onClick={() => changeDestination([...trail, { id: folder.id, name: folder.name }])}>
              {folder.name}
            </Button>
          ))}
          {next ? <Button variant="outline" disabled={loadingMore || busy || loading} onClick={() => void more()}>{loadingMore ? 'Loading folders…' : 'Load more folders'}</Button> : null}
          {!loading && !error && folders.length === 0 ? <p>No subfolders</p> : null}
        </div>
        {failures.length ? <ul aria-label="Files not moved" className="text-sm text-destructive">{failures.map((failure, i) => <li key={i}>{failure.message}</li>)}</ul> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {foldersFailed ? <Button variant="outline" disabled={busy || loading} onClick={() => setFolderRetry(value => value + 1)}>Retry destination folders</Button> : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => { if (busy) cancelled.current = true; else onClose(); }}>{busy ? 'Cancel remaining moves' : 'Cancel'}</Button>
          <Button disabled={busy || loading || foldersFailed || !remaining.length || destination.id === sourceFolderId}
            onClick={() => void submit()}>{busy ? 'Moving…' : 'Move here'}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
