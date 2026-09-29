/**
 * The drive screen — the first of the portal's surfaces to run against the vertical
 * (S12, #64).
 *
 * Ported rather than reinvented: the layout, the row shape, the icon-by-kind and the
 * per-row action menu are the portal's, rebuilt on `@canopy/ui` because the portal's
 * own copies of those primitives live behind its `@/components/ui` alias. What is
 * deliberately NOT here is what the vertical cannot do yet — Move waits on the grant
 * decision (#75), and preview/viewers wait on the plugin seam (#73), so neither appears
 * as a menu item that does nothing.
 *
 * Folders and files are one list, folders first, because that is what a drive looks
 * like — but they are two reads and two entity types underneath, and the actions differ.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Icon, Input, cn } from '@canopy/ui';
import { latestOnly } from './reads';
import { PreviewPanel } from './preview';
import { FileTable, type SortKey, type SortState } from './file-table';
import { Topbar } from './topbar';
import { CommandPalette } from './command-palette';
import type { Me } from './api';
import { kindOf, type FileItem } from './items';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@canopy/ui';
import {
  ROOT_FOLDER_ID,
  SEARCH_MIN,
  contentUrl,
  createFolder,
  listFolder,
  listFolders,
  listTrash,
  moveFile,
  moveFolder,
  renameFile,
  renameFolder,
  restoreFile,
  search,
  trashFile,
  uploadFile,
  type DriveFile,
  type DriveFolder,
  type SearchHit,
} from './api';

/**
 * Every icon this screen asks for, named once.
 *
 * `Icon` renders a puzzle piece for a name it does not know — a silent fallback, which
 * is the right behaviour for a plugin-supplied name and a trap for ours. Listing them
 * here lets a test assert they all resolve, so a typo is a failure rather than a
 * puzzle piece somebody eventually notices.
 */
export const DRIVE_ICONS = [
  'folder',
  'file-text',
  'chevron-right',
  'trash',
  'plus',
  'upload',
  'more',
  'search',
  'grid',
  'list',
] as const;
export type IconName = (typeof DRIVE_ICONS)[number];

/**
 * The order the table displays, applied to the rows before they become items.
 *
 * The table reports a sort and renders what it is given — it does not sort itself, which
 * is a fact about the component that only a test surfaces. Folders always lead, because a
 * drive that interleaves them is a drive nobody can scan.
 */
function sorted<T extends { name: string; updated_at?: string }>(rows: T[], sort: SortState): T[] {
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) =>
    sort.key === 'modified'
      ? dir * (a.updated_at ?? '').localeCompare(b.updated_at ?? '')
      : dir * a.name.localeCompare(b.name),
  );
}

/** Bytes, as the table's `size` column wants them: already formatted, or an em dash. */
function sizeLabel(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const folderItem = (folder: DriveFolder): FileItem => ({
  id: folder.id,
  name: folder.name,
  kind: 'folder',
  modified: '—',
  size: '—',
  isFolder: true,
  path: folder.path,
});

const fileItem = (file: DriveFile, mime?: string | null): FileItem => ({
  id: file.id,
  name: file.name,
  // The kind is a presentation fact derived from the version's mime; a listing does not
  // carry versions, so an unwritten file reads as a plain document until it is opened.
  kind: file.current_version_id ? kindOf(mime) : 'doc',
  modified: file.current_version_id ? when(file.updated_at) : 'No content yet',
  size: '—',
  isFolder: false,
});

/** A breadcrumb: the trail back to the root, built from the folder's own path. */
interface Crumb {
  id: string;
  name: string;
}

export interface DriveScreenProps {
  onError: (message: string | null) => void;
  /** The shell's account menu lives in the topbar, which this screen renders. */
  auth: Me;
  onSignIn: () => void;
  onSignOut: () => void;
}

export function DriveScreen({ onError, auth, onSignIn, onSignOut }: DriveScreenProps) {
  const [folderId, setFolderId] = useState(ROOT_FOLDER_ID);
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'drive' | 'trash' | 'search'>('drive');
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [trash, setTrash] = useState<DriveFile[]>([]);
  const [renaming, setRenaming] = useState<{ kind: 'file' | 'folder'; id: string; name: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  /** The topbar's Upload button and the palette's action both reach the one file input. */
  const uploadRef = useRef<HTMLInputElement>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [layout, setLayout] = useState<'list' | 'grid'>('list');
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' });
  const reads = useRef(latestOnly());
  /**
   * The CURRENT refresh, not the one an action closed over.
   *
   * An action started in folder A resolves after the user has opened folder B. Calling
   * the refresh it captured would read folder A — and, worse, claim the screen's ticket
   * while doing it, so folder B's own read could no longer correct the result. A ref
   * keeps "refresh what is on screen" true at the moment it is called.
   */
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  /** One refresh for both views, so an action never leaves half the screen stale. */
  const refresh = useCallback(async () => {
    const ticket = reads.current.take();
    setBusy(true);
    try {
      if (view === 'search') {
        // Below the floor there is nothing to ask for, and asking would be a 400.
        const q = term.trim();
        const found = q.length >= SEARCH_MIN ? (await search(q)).hits : [];
        // Checked AFTER the await, every time: an answer that arrives for a term the
        // box no longer holds is stale, and writing it is how a search shows results
        // for what you typed a moment ago.
        if (!reads.current.current(ticket)) return;
        setHits(found);
      } else if (view === 'trash') {
        const bin = await listTrash();
        if (!reads.current.current(ticket)) return;
        setTrash(bin);
      } else {
        const [subfolders, contents] = await Promise.all([listFolders(folderId), listFolder(folderId)]);
        if (!reads.current.current(ticket)) return;
        setFolders(subfolders);
        setFiles(contents);
      }
      onError(null);
    } catch (e: unknown) {
      // A stale failure is as misleading as a stale answer: the folder it belonged to
      // is not the one on screen.
      if (!reads.current.current(ticket)) return;
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      if (reads.current.current(ticket)) setBusy(false);
    }
  }, [folderId, view, term, onError]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  /** ⌘K / Ctrl-K opens the palette — the shortcut the portal had, and the reason it exists. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setCmdOpen((was) => !was);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    // A pause, not a keystroke: the index is per scope and cheap, but a request per
    // character still races its own answers and the last one to land wins.
    const t = setTimeout(() => void refresh(), view === 'search' ? 200 : 0);
    return () => clearTimeout(t);
  }, [refresh, view]);

  const open = (folder: DriveFolder) => {
    // The listing on screen belongs to the folder being left; nothing in flight for it
    // may land here.
    reads.current.invalidate();
    setCrumbs((c) => [...c, { id: folder.id, name: folder.name }]);
    setFolderId(folder.id);
  };

  const upTo = (index: number) => {
    reads.current.invalidate();
    // -1 is the root: the crumb trail holds everything below it.
    setCrumbs((c) => c.slice(0, index + 1));
    setFolderId(index < 0 ? ROOT_FOLDER_ID : crumbs[index]!.id);
  };

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      // Through the ref: whatever the screen shows NOW, which may not be where this
      // action started.
      await refreshRef.current();
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Clicking a column header: same key toggles direction, a new key starts ascending. */
  const onSort = (key: SortKey) =>
    setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));

  /**
   * The table emits action names; this is where they become operations.
   *
   * Only the ones that exist: the table's own menu offers Rename, Move, Delete and Download,
   * and anything it would offer without an operation behind it was removed when the
   * component moved rather than wired to nothing here.
   */
  const onAction = (action: string, item: FileItem) => {
    if (action === 'Open') {
      const folder = folders.find((f) => f.id === item.id);
      if (folder) open(folder);
      else setPreviewing(item.id);
      return;
    }
    if (action === 'Rename') {
      setRenaming({ kind: item.isFolder ? 'folder' : 'file', id: item.id, name: item.name });
      return;
    }
    if (action === 'Delete') {
      if (!item.isFolder) void act(() => trashFile(item.id));
      return;
    }
    if (action === 'Download' && !item.isFolder) {
      window.open(contentUrl(item.id), '_blank', 'noopener');
      return;
    }
    if (action === 'Move') {
      // Up one level, as before — a destination picker is its own screen.
      const up = crumbs[crumbs.length - 2]?.id ?? ROOT_FOLDER_ID;
      if (crumbs.length > 0) {
        void act(() => (item.isFolder ? moveFolder(item.id, up) : moveFile(item.id, up)));
      }
    }
  };

  const onUpload = (input: HTMLInputElement) => {
    const chosen = Array.from(input.files ?? []);
    input.value = '';
    if (chosen.length === 0) return;
    void act(async () => {
      // Sequential on purpose: each upload is a body the isolate holds while it hashes
      // it, and three at once is three times the memory for no wall-clock worth having.
      for (const file of chosen) await uploadFile(folderId, file);
    });
  };

  return (
    <>
      <Topbar
        breadcrumb={['My Drive', ...crumbs.map((c) => c.name)]}
        // The topbar counts the root as crumb 0; `upTo` counts it as -1.
        onCrumbClick={(index) => upTo(index - 1)}
        onOpenCmd={() => setCmdOpen(true)}
        onUpload={() => uploadRef.current?.click()}
        onRefresh={() => void refresh()}
        syncing={busy}
        auth={auth}
        onSignIn={onSignIn}
        onSignOut={onSignOut}
      />

      <input
        ref={uploadRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => onUpload(e.currentTarget)}
      />

      <CommandPalette
        open={cmdOpen}
        onOpenChange={setCmdOpen}
        files={[...folders.map(folderItem), ...files.map((file) => fileItem(file))]}
        onNavigate={(id) => setView(id === 'trash' ? 'trash' : 'drive')}
        onOpenFile={(item) => setPreviewing(item.id)}
        onUpload={() => uploadRef.current?.click()}
      />

    <div className="flex min-h-0 gap-4">
      <div className="min-w-0 flex-1">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Icon
            name="search"
            className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={term}
            placeholder="Search this space"
            aria-label="Search this space"
            className="h-8 w-44 pl-8 sm:w-56"
            onChange={(e) => {
              const next = e.currentTarget.value;
              // FIRST, before the debounce is even scheduled: the request for the
              // previous term is in flight and still holds the ticket until then.
              reads.current.invalidate();
              setTerm(next);
              // The previous term's hits are wrong the moment the box changes, so they
              // go now rather than lingering until the next answer lands. With `busy`
              // set, the list says "Loading…" instead of "No matches" for a search
              // that has not run yet.
              setHits([]);
              setBusy(next.trim().length >= SEARCH_MIN);
              // Emptying the box returns to where you were, rather than leaving an
              // empty result list that looks like "nothing here".
              setView(next.trim() ? 'search' : 'drive');
            }}
          />
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => setLayout((l) => (l === 'list' ? 'grid' : 'list'))}
          aria-label={layout === 'list' ? 'Switch to grid' : 'Switch to list'}
        >
          <Icon name={layout === 'list' ? 'grid' : 'list'} className="size-4" />
        </Button>

        <Button
          variant={view === 'trash' ? 'default' : 'outline'}
          size="sm"
          onClick={() => {
            reads.current.invalidate();
            setView((v) => {
              if (v === 'trash') return 'drive';
              setTerm('');
              return 'trash';
            });
          }}
        >
          <Icon name="trash" className="size-4" />
          Trash
        </Button>
        {view === 'drive' ? (
          <>
            <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
              <Icon name="plus" className="size-4" />
              New folder
            </Button>
            <Button size="sm" asChild>
              <label>
                <Icon name="upload" className="size-4" />
                Upload
                <input type="file" multiple className="hidden" onChange={(e) => onUpload(e.currentTarget)} />
              </label>
            </Button>
          </>
        ) : null}
      </div>

      {view === 'search' ? (
        <FileTable
          files={sorted(hits, sort).map((hit) => fileItem(hit))}
          selection={selection}
          onSelectionChange={setSelection}
          onOpen={(item) => setPreviewing(item.id)}
          sort={sort}
          onSort={onSort}
          view={layout}
          onAction={onAction}
          pluginMenuItems={() => []}
          loading={busy}
        />
      ) : view === 'trash' ? (
        <FileTable
          files={sorted(trash, sort).map((file) => fileItem(file))}
          selection={selection}
          onSelectionChange={setSelection}
          onOpen={(item) => void act(() => restoreFile(item.id))}
          sort={sort}
          onSort={onSort}
          view={layout}
          onAction={onAction}
          pluginMenuItems={() => []}
          loading={busy}
        />
      ) : (
        <FileTable
          files={[...sorted(folders, sort).map(folderItem), ...sorted(files, sort).map((file) => fileItem(file))]}
          selection={selection}
          onSelectionChange={setSelection}
          onOpen={(item) => {
            const folder = folders.find((f) => f.id === item.id);
            if (folder) open(folder);
            else setPreviewing(item.id);
          }}
          sort={sort}
          onSort={onSort}
          view={layout}
          onAction={onAction}
          // Drag a file onto a folder: the move the platform's relink makes safe (#75).
          onMove={(item, folder) => void act(() => moveFile(item.id, folder.id))}
          pluginMenuItems={() => []}
          previewOpen={previewing !== null}
          loading={busy}
        />
      )}
      </div>

      {previewing ? (
        <PreviewPanel
          fileId={previewing}
          onClose={() => setPreviewing(null)}
          onError={onError}
        />
      ) : null}

      {creating ? (
        <NameDialog
          title="New folder"
          initial=""
          confirm="Create"
          onCancel={() => setCreating(false)}
          onConfirm={(name) => {
            setCreating(false);
            void act(() => createFolder(folderId, name));
          }}
        />
      ) : null}

      {renaming ? (
        <NameDialog
          title={renaming.kind === 'folder' ? 'Rename folder' : 'Rename file'}
          initial={renaming.name}
          confirm="Rename"
          onCancel={() => setRenaming(null)}
          onConfirm={(name) => {
            const target = renaming;
            setRenaming(null);
            void act(() =>
              target.kind === 'folder' ? renameFolder(target.id, name) : renameFile(target.id, name),
            );
          }}
        />
      ) : null}
    </div>
    </>
  );
}

/**
 * One name, typed. The same shape the portal's `NameDialog` has, and it exists for the
 * same reason: `window.prompt` cannot be styled, cannot be tested and is blocked
 * outright in some embedded webviews.
 */
function NameDialog({
  title,
  initial,
  confirm,
  onCancel,
  onConfirm,
}: {
  title: string;
  initial: string;
  confirm: string;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  const trimmed = name.trim();
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal>
      <form
        className="w-full max-w-sm rounded-lg border border-border bg-background p-4 shadow-lg"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed) onConfirm(trimmed);
        }}
      >
        <h2 className="mb-3 text-sm font-medium">{title}</h2>
        {/* Named, because a dialog whose only field has no accessible name is one a
            screen reader announces as "edit text" — and one a test cannot address
            unambiguously when the toolbar also holds an input. */}
        <Input
          autoFocus
          aria-label={title}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          A name is one segment: no slashes, and not <code>.</code> or <code>..</code>
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!trimmed}>
            {confirm}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** Dates as the portal shows them: relative while it is useful, absolute after. */
function when(iso: string): string {
  const then = new Date(iso).getTime();
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}
