import { useEffect, useState } from 'react';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input } from '@canopy/ui';
import { currentSite, listFoldersPage, ROOT_FOLDER_ID, type DriveFolder } from './api';

/** The server takes at most this many extra categories per upload. */
export const MAX_EXTRA_CATEGORIES = 10;
/** How many folders the picker reads before it stops walking the tree. */
export const CATEGORY_LIST_CAP = 500;

/** Every folder in the space, breadth first from the top, up to `cap`. */
async function walkFolders(site: string | null, cap: number, alive: () => boolean) {
  const found: DriveFolder[] = [];
  let level = [ROOT_FOLDER_ID];
  while (level.length) {
    const below: string[] = [];
    for (const parent of level) {
      let next: string | null = null;
      do {
        if (!alive()) return { folders: found, capped: false };
        const page = await listFoldersPage(parent, next, site);
        for (const folder of page.entries) {
          if (found.length >= cap) return { folders: found, capped: true };
          found.push(folder);
          below.push(folder.id);
        }
        next = page.next;
      } while (next);
    }
    level = below;
  }
  return { folders: found, capped: false };
}

/**
 * An a3doc space's folders are categories, and a3doc files one document under several of them.
 * Before an upload, this picks the other categories it goes under besides the folder in view.
 */
export function CategoryUploadDialog({ files, primary, onCancel, onUpload }: {
  files: File[];
  /** The folder in view, which the upload always goes to. */
  primary: { id: string; path: string };
  onCancel: () => void;
  onUpload: (alsoIn: string[]) => void;
}) {
  const [site] = useState(currentSite);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [capped, setCapped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    walkFolders(site, CATEGORY_LIST_CAP, () => alive).then((result) => {
      if (!alive) return;
      setFolders(result.folders.filter(folder => folder.id !== primary.id).sort((a, b) => a.path.localeCompare(b.path)));
      setCapped(result.capped);
    }).catch((e: unknown) => {
      if (alive) setError(e instanceof Error ? e.message || 'Could not load categories.' : String(e));
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; };
  }, [site, primary.id, retry]);

  const full = picked.length >= MAX_EXTRA_CATEGORIES;
  const needle = filter.trim().toLowerCase();
  const shown = needle ? folders.filter(folder => folder.path.toLowerCase().includes(needle)) : folders;
  const toggle = (id: string) => setPicked(now => now.includes(id) ? now.filter(x => x !== id) : now.length >= MAX_EXTRA_CATEGORIES ? now : [...now, id]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>File under categories</DialogTitle>
          <DialogDescription>
            a3doc files {files.length === 1 ? 'the document' : 'each document'} under every category you pick. You can't change its categories afterwards in a3doc.
            Only categories that already hold your documents are listed.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm">{files.length === 1 ? `Uploading ${files[0]!.name}` : `Uploading ${files.length} files`}</p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked disabled readOnly />
          <span>{primary.path} <span className="text-muted-foreground">(this folder)</span></span>
        </label>
        <Input aria-label="Filter categories" placeholder="Filter categories" value={filter} onChange={(event) => setFilter(event.target.value)} />
        <div role="group" aria-label="Other categories" className="max-h-64 space-y-1 overflow-auto text-sm">
          {loading ? <p role="status">Loading categories…</p>
            : error ? null
            : shown.length ? shown.map(folder => {
              const on = picked.includes(folder.id);
              return <label key={folder.id} className="flex items-center gap-2">
                <input type="checkbox" checked={on} disabled={!on && full} onChange={() => toggle(folder.id)} />
                <span className="min-w-0 break-words">{folder.path}</span>
              </label>;
            })
            : <p className="text-muted-foreground">{folders.length ? 'No category matches.' : 'No other categories.'}</p>}
        </div>
        {capped ? <p className="text-xs text-muted-foreground">Only the first {CATEGORY_LIST_CAP} categories are listed.</p> : null}
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {full ? `You picked the most, ${MAX_EXTRA_CATEGORIES}. Unpick one to choose another.` : `Pick up to ${MAX_EXTRA_CATEGORIES} more.`}
        </p>
        {error ? <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">{error}</p>
          <Button variant="outline" onClick={() => setRetry(n => n + 1)}>Retry categories</Button>
        </div> : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={() => onUpload(picked)}>Upload</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
