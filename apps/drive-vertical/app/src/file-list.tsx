/**
 * The list view of the file table: Substrat's `<sub-entity-table>` over the rows the drive
 * already holds.
 *
 * The element owns what a list people work in has to get right — the ARIA grid and its one
 * tab stop, arrow keys, Space/Enter, cmd/ctrl+A, shift-ranges, keeping focus near a row that
 * went away, the drag preview — and reports gestures as events. What a gesture MEANS stays
 * here and in `drive.tsx`: opening, the per-row menu, and which rows take a drop.
 *
 * Cells are React, rendered through portals into the light-DOM elements the table's
 * `mount` hands over. One React tree rather than a root per cell, so the cells share the
 * app's context and re-render with this component. A portal's React events still bubble
 * through the React tree, but every control in a cell stops its own propagation, and the
 * table ignores DOM clicks that land on a control of its own.
 *
 * The drive reads and sorts the listing itself (offline mirror, live refresh), so the
 * table's source just serves that array, with no next page. The header's sort is the
 * drive's: a press is reported back as `onSort`, and a changed sort hands the table a new
 * source carrying it, which is the one way to give the element a query after its first read.
 *
 * A folder opens in place through the element's own tree (`childrenOf`): the twisty, Right/Left
 * and the indent are the table's, and each open level is read by the drive's `tree.read` with
 * the table's sort. Rows read that way are remembered here so their cells can draw.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DetailedHTMLProps, type HTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import '@substrat-run/elements/entity-table';
import type { Column, SubEntityTable } from '@substrat-run/elements/entity-table';
import type { TableQuery, TableSource } from '@substrat-run/elements/entity-table-model';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Icon } from '@canopy/ui';
import type { FileItem, FileKind } from './items';
import { FileIcon } from './file-icon';
import { SearchHighlight } from './search-highlight';
import { actionsFor, type PluginMenuItem, type SortKey, type SortState } from './file-table';

type SubEntityTableProps = DetailedHTMLProps<HTMLAttributes<SubEntityTable<FileItem, SortKey>>, SubEntityTable<FileItem, SortKey>> & {
  label?: string;
  selectable?: boolean;
  paging?: 'pages' | 'more' | 'scroll';
  'row-select'?: boolean;
  'row-open'?: boolean;
  'row-click'?: boolean;
  'row-draggable'?: boolean;
};

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'sub-entity-table': SubEntityTableProps;
    }
  }
}

/** One page of an open folder's rows; `next` is followed for "Load more" in that level. */
export interface FolderPage {
  entries: FileItem[];
  next: string | null;
}

/** Folders open in place. */
export interface FolderTree {
  /** Read an open folder's rows in the given order; `next` null is the first page. */
  read: (folder: FileItem, sort: SortState, next: string | null) => Promise<FolderPage>;
  /** A change closes every open folder: the rows they held belonged to another listing. */
  scope: string;
}

export interface FileListProps {
  files: FileItem[];
  searchQuery?: string;
  selection: Set<string>;
  onSelectionChange: (s: Set<string>) => void;
  onOpen: (f: FileItem) => void;
  sort: SortState;
  onSort: (key: SortKey) => void;
  onAction: (action: string, f: FileItem) => void;
  onMove?: (file: FileItem, folder: FileItem) => void;
  pluginMenuItems: (kind: FileKind) => PluginMenuItem[];
  previewOpen: boolean;
  readOnly: boolean;
  trashed: boolean;
  mirrored: boolean;
  tree?: FolderTree;
}

/** A cell the table has handed over, and the row it currently draws. */
interface Mounted {
  cell: HTMLElement;
  column: 'name' | 'modified' | 'actions';
  id: string;
}

const sameSet = (a: ReadonlySet<string>, b: Iterable<string>) => {
  const other = new Set(b);
  return a.size === other.size && [...a].every((key) => other.has(key));
};

/** A dragged folder may not land in itself or anywhere under it. */
const canDropOn = (folder: FileItem, dragged: FileItem[]) =>
  folder.isFolder && dragged.every((f) => f.id !== folder.id && !(f.isFolder && folder.path?.startsWith(`${f.path}/`)));

const NARROW = '(max-width: 767px)';
const narrowNow = () => !!window.matchMedia?.(NARROW).matches;

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(narrowNow);
  useEffect(() => {
    const query = window.matchMedia?.(NARROW);
    if (!query?.addEventListener) return;
    const changed = () => setNarrow(query.matches);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  return narrow;
}

function RowMenu({ file, onAction, readOnly, trashed, mirrored }: { file: FileItem; onAction: (action: string, f: FileItem) => void; readOnly: boolean; trashed: boolean; mirrored: boolean }) {
  const actions = actionsFor(file, readOnly, trashed, mirrored);
  if (actions.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          onClick={(e) => e.stopPropagation()}
          aria-label={`Actions for ${file.name}`}
          className="canopy-row-actions grid size-7 place-items-center rounded-md text-muted-foreground transition-opacity hover:bg-accent data-[state=open]:opacity-100"
        >
          <Icon name="more" size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44" onClick={(e) => e.stopPropagation()}>
        {actions.map((a) => (
          <DropdownMenuItem key={a} variant={a === 'Delete' ? 'destructive' : undefined} onSelect={() => onAction(a, file)}>
            {a}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function FileList({
  files, searchQuery, selection, onSelectionChange, onOpen, sort, onSort, onAction, onMove,
  pluginMenuItems, previewOpen, readOnly, trashed, mirrored, tree,
}: FileListProps) {
  const table = useRef<SubEntityTable<FileItem, SortKey>>(null);
  const rows = useRef(files);
  const latest = useRef({ files, selection, sort, onSelectionChange, onOpen, onSort, onMove, previewOpen, trashed, tree });
  // Refresh after commit, before the effects below read them: a render React throws away
  // must not leak its rows or callbacks into events on the table still on screen.
  useLayoutEffect(() => {
    rows.current = files;
    latest.current = { files, selection, sort, onSelectionChange, onOpen, onSort, onMove, previewOpen, trashed, tree };
  });

  const [mounted, setMounted] = useState<ReadonlyMap<string, Mounted>>(new Map());
  // Rows inside open folders, by id: the drive's `files` holds only the top level.
  const [nested, setNested] = useState<ReadonlyMap<string, FileItem>>(new Map());
  const [menu, setMenu] = useState<{ file: FileItem; x: number; y: number } | null>(null);
  const narrow = useNarrow();

  // A new source whenever the sort changes: the element takes a query only with a source.
  const source = useMemo<TableSource<FileItem, SortKey>>(() => {
    const page = () => Promise.resolve({ entries: rows.current, next: null, total: null });
    return { read: page, follow: page };
  }, [sort.key, sort.dir]);

  // Columns are stable: they draw by id, from `files`, so a changed row needs no new column.
  const columns = useMemo<Column<FileItem, SortKey>[]>(() => {
    const mount = (column: Mounted['column']) => (cell: HTMLElement, row: FileItem) => {
      const slot = `${column}\u0000${row.id}`;
      setMounted((m) => new Map(m).set(slot, { cell, column, id: row.id }));
      return {
        update: (next: FileItem) => setMounted((m) => {
          const known = m.get(slot);
          return known && known.id === next.id ? m : new Map(m).set(slot, { cell, column, id: next.id });
        }),
        unmount: () => setMounted((m) => {
          if (!m.has(slot)) return m;
          const next = new Map(m);
          next.delete(slot);
          return next;
        }),
      };
    };
    return [
      { key: 'name', label: 'Name', value: (f) => f.name, sort: 'name', priority: 1, mount: mount('name') },
      { key: 'modified', label: 'Modified', value: (f) => f.modified, sort: 'modified', priority: 2, width: '124px', mount: mount('modified') },
      { key: 'actions', label: '', value: () => '', priority: 1, width: '44px', mount: mount('actions') },
    ];
  }, []);

  useEffect(() => {
    const el = table.current!;
    el.columns = columns;
  }, [columns]);

  useEffect(() => {
    const el = table.current!;
    el.query = { sort: sort.key, order: sort.dir };
    el.source = source;
  }, [source, sort.key, sort.dir]);

  // A new scope (another folder on screen) closes what was open and forgets its rows.
  const treeOn = !!tree;
  const scope = tree?.scope;
  useEffect(() => {
    if (scope === undefined) return;
    setNested(new Map());
    table.current!.open = [];
  }, [scope]);
  // Set once: a new `childrenOf` makes the element re-read every level still open.
  useEffect(() => {
    const el = table.current!;
    if (!treeOn) {
      el.childrenOf = undefined;
      el.canExpand = undefined;
      return;
    }
    el.canExpand = (f) => f.isFolder;
    el.childrenOf = (folder) => {
      let order: SortState = latest.current.sort;
      const page = async (next: string | null) => {
        const read = latest.current.tree;
        if (!read) return { entries: [], next: null, total: null };
        const { entries, next: following } = await read.read(folder, order, next);
        // Another folder came on screen while this one read: its rows belong to the old scope.
        if (latest.current.tree?.scope !== read.scope) return { entries: [], next: null, total: null };
        setNested((m) => {
          const known = new Map(m);
          for (const row of entries) known.set(row.id, row);
          return known;
        });
        return { entries, next: following, total: null };
      };
      return {
        read: (query) => {
          order = query.sort ? { key: query.sort, dir: query.order } : latest.current.sort;
          return page(null);
        },
        follow: (next) => page(next),
      };
    };
  }, [treeOn]);

  // The drive re-read or re-sorted: read the rows again, keeping the selection and focus.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    // After the element has taken any change set this commit (folders closed by a new
    // scope above), so the reload reads only what is open now.
    const el = table.current;
    if (el) void el.updateComplete.then(() => el.reload());
  }, [files]);

  useEffect(() => {
    const el = table.current!;
    if (!el.selection || !sameSet(selection, el.selection)) el.selection = [...selection];
  }, [selection]);

  useEffect(() => {
    const el = table.current!;
    el.rowRank = (f) => (f.isFolder ? 0 : 1);
    el.canDrag = () => true;
    el.canDrop = (target, dragged) => canDropOn(target, dragged);
    el.dragLabel = (dragged) => (dragged.length === 1 ? dragged[0]!.name : `${dragged.length} items`);
  }, []);

  useEffect(() => {
    const el = table.current!;
    const detail = <T,>(e: Event) => (e as CustomEvent<T>).detail;
    // In the Trash, opening restores. A double-click is deliberate; Enter is too easily
    // pressed on its way somewhere else, so an open that came from Enter is not one there.
    // The host hears a key in the capture phase, before the table inside it does.
    let enter = false;
    const keydown = (e: KeyboardEvent) => { enter = e.key === 'Enter'; };
    const keyup = () => { enter = false; };
    el.addEventListener('keydown', keydown, true);
    el.addEventListener('keyup', keyup, true);
    const on: Record<string, (e: Event) => void> = {
      'sub-selection-change': (e) => {
        const { keys } = detail<{ keys: string[] }>(e);
        if (!sameSet(latest.current.selection, keys)) latest.current.onSelectionChange(new Set(keys));
      },
      'sub-row-open': (e) => {
        if (latest.current.trashed && enter) return;
        latest.current.onOpen(detail<{ row: FileItem }>(e).row);
      },
      'sub-row-click': (e) => {
        const { row } = detail<{ row: FileItem }>(e);
        // On a phone a tap opens: a double-tap zooms instead. With the preview docked, a
        // click swaps it to the clicked file; folders still need a double-click to navigate.
        if (narrowNow()) latest.current.onOpen(row);
        else if (latest.current.previewOpen && !row.isFolder) latest.current.onOpen(row);
      },
      'sub-row-contextmenu': (e) => {
        const { row, x, y } = detail<{ row: FileItem; x: number; y: number }>(e);
        e.preventDefault();
        setMenu({ file: row, x, y });
      },
      'sub-row-dragstart': (e) => {
        const { rows: dragged, dataTransfer } = detail<{ rows: FileItem[]; dataTransfer: DataTransfer | null }>(e);
        // Marks an internal move, so the "drop files to upload" overlay (keyed off "Files") stays hidden.
        dataTransfer?.setData('application/x-canopy-file', dragged.map((f) => f.id).join(','));
        if (dataTransfer) dataTransfer.effectAllowed = 'move';
      },
      'sub-row-drop': (e) => {
        const { target, dragged } = detail<{ target: FileItem; dragged: FileItem[] }>(e);
        if (!canDropOn(target, dragged)) return;
        for (const file of dragged) latest.current.onMove?.(file, target);
      },
      'sub-query-change': (e) => {
        const { query } = detail<{ query: TableQuery<SortKey> }>(e);
        const now = latest.current.sort;
        // The header cycles asc → desc → the read's own order; the drive has no "own order",
        // so the third press goes back to ascending on the same column.
        if (query.sort === null) { if (now.dir === 'desc') latest.current.onSort(now.key); }
        else if (query.sort !== now.key || query.order !== now.dir) latest.current.onSort(query.sort);
      },
    };
    for (const [type, handler] of Object.entries(on)) el.addEventListener(type, handler);
    return () => {
      for (const [type, handler] of Object.entries(on)) el.removeEventListener(type, handler);
      el.removeEventListener('keydown', keydown, true);
      el.removeEventListener('keyup', keyup, true);
    };
  }, []);

  const byId = new Map(nested);
  for (const f of files) byId.set(f.id, f);
  const menuFile = menu ? byId.get(menu.file.id) ?? menu.file : null;
  const menuActions = menuFile ? actionsFor(menuFile, readOnly, trashed, mirrored) : [];
  const menuPlugins = menuFile && !readOnly ? pluginMenuItems(menuFile.kind) : [];

  return (
    <>
      <sub-entity-table
        ref={table}
        className="canopy-files"
        label="Files"
        selectable
        paging="more"
        // On a phone a tap opens and nothing else: no double-click to wait for, and the
        // checkbox is how a selection starts.
        row-select={narrow ? undefined : true}
        row-open={narrow ? undefined : true}
        row-click
        row-draggable={!!onMove && !readOnly ? true : undefined}
      />
      {[...mounted.entries()].map(([slot, { cell, column, id }]) => {
        const f = byId.get(id);
        if (!f) return null;
        return createPortal(
          column === 'name' ? (
            <div className="flex min-w-0 items-center gap-3">
              <FileIcon kind={f.kind} />
              <div className="min-w-0">
                <span className="block max-w-[calc(100vw-9rem)] truncate font-medium md:max-w-none">
                  {searchQuery ? <SearchHighlight text={f.name} query={searchQuery} mode="prefix" /> : f.name}
                </span>
                {f.description ? (
                  <p className="line-clamp-2 [overflow-wrap:anywhere] text-xs text-muted-foreground">
                    {searchQuery && f.snippet ? <SearchHighlight text={f.snippet} query={searchQuery} mode="substring" /> : f.description}
                  </p>
                ) : null}
              </div>
            </div>
          ) : column === 'modified' ? (
            <span className="font-mono text-[12.5px] text-muted-foreground">{f.modified}</span>
          ) : (
            <RowMenu file={f} onAction={onAction} readOnly={readOnly} trashed={trashed} mirrored={mirrored} />
          ),
          cell,
          slot,
        );
      })}
      {/* Right-click: the table selects the row and reports where; the menu is drawn here. */}
      <DropdownMenu open={!!menu && (menuActions.length > 0 || menuPlugins.length > 0)} onOpenChange={(open) => { if (!open) setMenu(null); }}>
        <DropdownMenuTrigger asChild>
          <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }} />
        </DropdownMenuTrigger>
        {menuFile ? (
          <DropdownMenuContent align="start" className="w-48">
            {menuActions.map((a) => (
              // Open is the double-click, so it goes straight there rather than through `onAction`.
              <DropdownMenuItem key={a} variant={a === 'Delete' ? 'destructive' : undefined} onSelect={() => (a === 'Open' ? onOpen(menuFile) : onAction(a, menuFile))}>
                {a}
              </DropdownMenuItem>
            ))}
            {menuPlugins.length > 0 && menuActions.length > 0 && <DropdownMenuSeparator />}
            {menuPlugins.map((item) => (
              <DropdownMenuItem key={item.pluginId + item.label} onSelect={() => onAction(item.label, menuFile)}>
                {item.icon && <Icon name={item.icon} size={15} />}
                {item.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        ) : null}
      </DropdownMenu>
    </>
  );
}
