import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@canopy/ui';
import { listFoldersPage, appendRows, moveFile, moveFolder, ROOT_FOLDER_ID, type DriveFolder } from './api';
import { latestOnly } from './reads';
import type { FileItem } from './items';

/** Same-space destinations; the server checks source and destination permissions. */
export function MoveDialog({ items, sourceFolderId, onClose, onMoved }: {
  items: FileItem[];
  sourceFolderId: string | null;
  onClose: () => void;
  onMoved: () => Promise<void>;
}) {
  const reads = useRef(latestOnly()).current;
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [trail, setTrail] = useState([{ id: ROOT_FOLDER_ID, name: 'My Drive' }]);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(items);
  const destination = trail[trail.length - 1]!;

  useEffect(() => {
    const ticket = reads.take();
    setNext(null);
    setLoadingMore(false);
    setLoading(true);
    setFolders([]);
    setError(null);
    listFoldersPage(destination.id).then((answer) => {
      if (reads.current(ticket)) { setFolders(answer.entries); setNext(answer.next); }
    }).catch((e: unknown) => {
      if (reads.current(ticket)) setError(e instanceof Error ? e.message : String(e));
    }).finally(() => {
      if (reads.current(ticket)) setLoading(false);
    });
    return () => reads.invalidate();
  }, [destination.id]);

  const more = async () => {
    if (!next || loadingMore || loading || busy) return;
    const ticket = reads.take();
    setLoadingMore(true);
    setError(null);
    try {
      const page = await listFoldersPage(destination.id, next);
      if (reads.current(ticket)) { setFolders(rows => appendRows(rows, page.entries)); setNext(page.next); }
    } catch (e: unknown) {
      if (reads.current(ticket)) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (reads.current(ticket)) setLoadingMore(false);
    }
  };

  const blocked = (folder: DriveFolder) => remaining.some((item) => item.isFolder && (
    folder.id === item.id || folder.path.startsWith(`${item.path}/`)
  ));

  const submit = async () => {
    setBusy(true);
    setError(null);
    let left = remaining;
    try {
      // Each operation is atomic. Keep successful items out of a partial-failure retry.
      for (const item of remaining) {
        if (item.isFolder) await moveFolder(item.id, destination.id);
        else await moveFile(item.id, destination.id);
        left = left.filter((candidate) => candidate.id !== item.id);
        setRemaining(left);
      }
      onClose();
    } catch (e: unknown) {
      setError(`${remaining.length - left.length} moved; ${left.length} remaining. ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await onMoved();
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move {items.length === 1 ? items[0]!.name : `${items.length} items`}</DialogTitle>
          <DialogDescription>Choose a folder in this space. Access follows the destination; existing names are refused.</DialogDescription>
        </DialogHeader>
        <nav aria-label="Destination path" className="flex flex-wrap gap-2">
          {trail.map((crumb, index) => (
            <Button key={crumb.id} variant="ghost" size="sm" disabled={busy}
              onClick={() => setTrail(trail.slice(0, index + 1))}>{crumb.name}</Button>
          ))}
        </nav>
        <div aria-label="Destination folders" className="max-h-64 overflow-auto">
          {loading ? <p role="status">Loading folders…</p> : folders.map((folder) => (
            <Button key={folder.id} variant="ghost" className="w-full justify-start"
              disabled={busy || blocked(folder)}
              onClick={() => setTrail([...trail, { id: folder.id, name: folder.name }])}>
              {folder.name}
            </Button>
          ))}
          {next ? <Button variant="outline" disabled={loadingMore || busy || loading} onClick={() => void more()}>{loadingMore ? 'Loading folders…' : 'Load more folders'}</Button> : null}
          {!loading && !error && folders.length === 0 ? <p>No subfolders</p> : null}
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy || loading || destination.id === sourceFolderId}
            onClick={() => void submit()}>{busy ? 'Moving…' : 'Move here'}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
