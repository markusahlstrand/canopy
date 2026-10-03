import { useRef, useState, type ReactNode, type KeyboardEvent } from "react";
import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
import type { FileItem } from './items';
import { SearchHighlight } from "./search-highlight";
import { FileIcon } from './file-icon';
import { Checkbox } from "@canopy/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@canopy/ui";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@canopy/ui";
import { Skeleton } from "@canopy/ui";
import { Icon } from "@canopy/ui";
import { cn } from "@canopy/ui";
import type { FileKind } from './items';

export interface PluginMenuItem {
  pluginId: string;
  label: string;
  icon?: string;
}

/** No `shared` here yet: the column went with sharing, which has no operations. */
/** No `size`: a folder listing does not carry one, so the column is not rendered. */
export type SortKey = "name" | "modified";
export interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}

interface FileTableProps {
  files: FileItem[];
  searchQuery?: string;
  selection: Set<string>;
  onSelectionChange: (s: Set<string>) => void;
  onOpen: (f: FileItem) => void;
  sort: SortState;
  onSort: (key: SortKey) => void;
  view: "list" | "grid";
  onAction: (action: string, f: FileItem) => void;
  /** Drop a dragged file into a folder. Both items come from this table. */
  onMove?: (file: FileItem, folder: FileItem) => void;
  pluginMenuItems: (kind: FileKind) => PluginMenuItem[];
  /** When a preview is docked open beside the list, a plain click swaps it to the
   *  clicked file (Drive/Finder-style) instead of waiting for a double-click. */
  previewOpen?: boolean;
  /** A cold load is in flight. With nothing cached to show yet, render skeleton
   *  placeholders instead of an empty table (gated on `files.length === 0`, so a
   *  background re-sync over already-listed files never flashes the skeleton). */
  loading?: boolean;
  /** Offline metadata can be browsed, but bytes and mutations are unavailable. */
  readOnly?: boolean;
  trashed?: boolean;
  /** The view owns the reason its result is empty and the useful next action. */
  empty?: ReactNode;
}

// Varied bar widths so skeleton rows/cards read as real names, not a grid of equals.
const SKELETON_NAME_W = ["w-40", "w-56", "w-32", "w-48", "w-64", "w-36", "w-52", "w-44"];

function FileTableSkeleton({ view }: { view: "list" | "grid" }) {
  if (view === "grid") {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3" aria-hidden>
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2.5 rounded-lg border p-3.5">
            <Skeleton className="size-[38px] rounded-lg" />
            <Skeleton className={cn("h-3.5", SKELETON_NAME_W[i % SKELETON_NAME_W.length])} />
            <div className="flex items-center justify-between">
              <Skeleton className="h-3 w-12" />
              <Skeleton className="size-5 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border" aria-hidden>
      <table className="w-full border-collapse text-[14px]">
        <thead>
          <tr className="border-b bg-muted/40">
            <th className="w-9 px-3 py-2.5" />
            {COLUMNS.map((col) => (
              <th key={col.key} className={cn("px-3 py-2.5", col.className)}>
                <span className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
                  {col.label}
                </span>
              </th>
            ))}
            <th className="w-10" />
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 8 }).map((_, i) => (
            <tr key={i} className="border-t" style={{ height: "var(--row-h)" }}>
              <td className="px-3">
                <Skeleton className="size-4 rounded" />
              </td>
              <td className="px-3">
                <div className="flex items-center gap-3">
                  <Skeleton className="size-7 rounded" />
                  <Skeleton className={cn("h-3.5", SKELETON_NAME_W[i % SKELETON_NAME_W.length])} />
                </div>
              </td>
              <td className="hidden px-3 md:table-cell">
                <Skeleton className="h-3.5 w-16" />
              </td>
              <td className="px-2"><Skeleton className="size-5 rounded" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A folder in this space — a valid move destination.
 *
 * The portal tested `id.startsWith("folder:")` because its folder rows were synthetic,
 * keyed by path, and that also excluded its cross-space rows (space mounts, "shared with
 * me"). A scope's folders are ordinary entities with ULIDs and there is nothing
 * cross-space in a listing, so the prefix test rejected every folder and took
 * drag-to-move with it.
 */
const isFolderDropTarget = (f: FileItem) => f.isFolder;

const COLUMNS: { key: SortKey; label: string; className: string }[] = [
  { key: "name", label: "Name", className: "" },
  { key: "modified", label: "Modified", className: "hidden w-[124px] md:table-cell" },
];

/**
 * What the menus offer, per row — and nothing beyond what `onAction` can perform.
 *
 * `Share` and `Reprocess` came across with the component and have no operations behind
 * them; a folder cannot be downloaded or trashed either, so those are file-only. The rule
 * is the same one the rest of this UI follows: an item that does nothing is worse than an
 * item that is absent.
 */
export function actionsFor(file: FileItem, readOnly = false, trashed = false): string[] {
  if (readOnly) return file.isFolder ? ['Open'] : [];
  if (trashed) return ['Restore'];
  // Share is a FOLDER action and only a folder action: a grant narrows onto a folder and
  // reaches what is under it, so there is no such thing as sharing one file here.
  return file.isFolder
    ? ['Open', 'Share', 'Rename', 'Move']
    : ['Open', 'Download', 'Rename', 'Move', 'Delete'];
}

function RowActions({ file, onAction, readOnly, trashed }: { file: FileItem; onAction: (action: string, f: FileItem) => void; readOnly: boolean; trashed?: boolean }) {
  const actions = actionsFor(file, readOnly, trashed);
  if (actions.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          onClick={(e) => e.stopPropagation()}
          aria-label={`Actions for ${file.name}`}
          className="grid size-7 place-items-center rounded-md text-muted-foreground opacity-100 transition-opacity hover:bg-accent md:opacity-0 md:group-hover:opacity-100 data-[state=open]:opacity-100"
        >
          <Icon name="more" size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44" onClick={(e) => e.stopPropagation()}>
        {actions.map((a) => (
          <DropdownMenuItem
            key={a}
            variant={a === "Delete" ? "destructive" : undefined}
            onSelect={() => onAction(a, file)}
          >
            {a}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function FileTable({
  searchQuery,
  files,
  selection,
  onSelectionChange,
  onOpen,
  sort,
  onSort,
  view,
  onAction,
  onMove,
  pluginMenuItems,
  previewOpen = false,
  loading = false,
  readOnly = false,
  trashed = false,
  empty,
}: FileTableProps) {
  const lastIndex = useRef<number | null>(null);
  // Internal file→folder drag-and-drop. The dragged file is held in a ref;
  // the folder currently under the cursor is tracked in state for the highlight.
  const dragged = useRef<FileItem | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  function canDrop(folder: FileItem): boolean {
    const f = dragged.current;
    return !!onMove && !!f && isFolderDropTarget(folder) && f.id !== folder.id
      && !(f.isFolder && folder.path?.startsWith(`${f.path}/`));
  }

  function dragHandlers(f: FileItem) {
    if (!onMove) return {};
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        dragged.current = f;
        // A custom type marks this as an internal move so the app-level
        // "drop files to upload" overlay (which keys off "Files") stays hidden.
        e.dataTransfer.setData("application/x-canopy-file", f.id);
        e.dataTransfer.effectAllowed = "move";
      },
      onDragEnd: () => {
        dragged.current = null;
        setDragOverId(null);
      },
    };
  }

  function dropHandlers(folder: FileItem) {
    if (!onMove || !isFolderDropTarget(folder)) return {};
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!canDrop(folder)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setDragOverId(folder.id);
      },
      onDragLeave: () => setDragOverId((id) => (id === folder.id ? null : id)),
      onDrop: (e: React.DragEvent) => {
        const file = dragged.current;
        setDragOverId(null);
        if (!file || !canDrop(folder)) return;
        e.preventDefault();
        e.stopPropagation();
        onMove!(file, folder);
        dragged.current = null;
      },
    };
  }

  function handleRowClick(e: React.MouseEvent, index: number, id: string) {
    const plain = !e.shiftKey && !e.metaKey && !e.ctrlKey;
    // On a phone, tapping a row opens it. Selection still has its checkbox; asking for
    // a double-tap makes the drive feel inert because that gesture zooms in browsers.
    if (plain && window.matchMedia?.('(max-width: 767px)').matches) {
      onOpen(files[index]!);
      return;
    }
    const next = new Set(selection);
    if (e.shiftKey && lastIndex.current != null) {
      const [a = 0, b = 0] = [lastIndex.current, index].sort((x, y) => x - y);
      for (let i = a; i <= b; i++) {
        const row = files[i];
        if (row) next.add(row.id);
      }
    } else if (e.metaKey || e.ctrlKey) {
      if (next.has(id)) next.delete(id);
      else next.add(id);
      lastIndex.current = index;
    } else {
      next.clear();
      next.add(id);
      lastIndex.current = index;
    }
    onSelectionChange(next);
    // With the preview docked open, a plain click swaps it to the clicked file so
    // browsing (e.g. flipping through images) is one click each. Modifier-clicks build
    // a selection, and folders still need a double-click to navigate, so leave those be.
    if (plain && previewOpen && files[index]!.kind !== "folder") onOpen(files[index]!);
  }

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focusedIndex = Math.max(0, files.findIndex(file => file.id === focusedId));
  const keyboard = (index: number) => (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || event.altKey || event.nativeEvent.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault(); event.stopPropagation(); onSelectionChange(new Set(files.map(file => file.id))); return;
    }
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    let next = index;
    if (event.key === 'ArrowDown' || (view === 'grid' && event.key === 'ArrowRight')) next++;
    else if (event.key === 'ArrowUp' || (view === 'grid' && event.key === 'ArrowLeft')) next--;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = files.length - 1;
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); event.stopPropagation(); if (event.repeat) return;
      if (event.key === 'Enter') onOpen(files[index]!);
      else { const selected = new Set(selection); const id = files[index]!.id; if (selected.has(id)) selected.delete(id); else selected.add(id); onSelectionChange(selected); }
      return;
    } else return;
    event.preventDefault(); event.stopPropagation(); next = Math.max(0, Math.min(files.length - 1, next));
    setFocusedId(files[next]!.id);
    (event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[data-file-row]')[next])?.focus();
  };
  const rowFocus = (index: number) => ({ 'data-file-row': '', tabIndex: index === focusedIndex ? 0 : -1,
    onFocus: () => setFocusedId(files[index]!.id), onKeyDown: keyboard(index),
    'aria-label': files[index]!.name, 'aria-keyshortcuts': 'ArrowDown ArrowUp Home End Enter Space',
  });

  const allSelected = files.length > 0 && files.every((f) => selection.has(f.id));

  // Cold load: nothing cached to show yet. (Navigating between cached folders keeps
  // the previous list visible until the new one resolves, so no skeleton there.)
  if (loading && files.length === 0) return <FileTableSkeleton view={view} />;
  if (files.length === 0) return <>{empty}</>;

  if (view === "grid") {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
        {files.map((f, i) => (
          <div
            key={f.id}
            role="group"
            {...rowFocus(i)}
            {...dragHandlers(f)}
            {...dropHandlers(f)}
            onClick={(e) => handleRowClick(e, files.indexOf(f), f.id)}
            onDoubleClick={() => onOpen(f)}
            className={cn(
              "focus-visible:outline-2 focus-visible:outline-primary group flex cursor-default flex-col gap-2.5 rounded-lg border p-3.5 transition-colors",
              dragOverId === f.id
                ? "border-primary bg-primary/10 ring-2 ring-primary"
                : selection.has(f.id)
                  ? "border-primary/40 bg-primary/[0.06]"
                  : "hover:bg-muted/50",
            )}
          >
            <div className="flex items-start justify-between">
              <FileIcon kind={f.kind} size={38} />
              <div className="flex items-center gap-1">
                <Checkbox
                  aria-label={`Select ${f.name}`}
                  checked={selection.has(f.id)}
                  onClick={(e) => e.stopPropagation()}
                  onCheckedChange={() => {
                    const next = new Set(selection);
                    if (next.has(f.id)) next.delete(f.id);
                    else next.add(f.id);
                    onSelectionChange(next);
                  }}
                />
                <RowActions file={f} onAction={onAction} readOnly={readOnly} trashed={trashed} />
              </div>
            </div>
            <div className="truncate text-[13.5px] font-medium">{searchQuery ? <SearchHighlight text={f.name} query={searchQuery} mode="prefix" /> : f.name}</div>
            {f.description ? <p className="line-clamp-2 [overflow-wrap:anywhere] text-xs text-muted-foreground">{searchQuery && f.snippet ? <SearchHighlight text={f.snippet} query={searchQuery} mode="substring" /> : f.description}</p> : null}
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11.5px] text-muted-foreground">{f.modified}</span>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full border-collapse text-[14px]">
        <thead>
          <tr className="border-b bg-muted/40">
            <th className="w-9 px-3 py-2.5">
              <Checkbox
                checked={allSelected}
                onCheckedChange={(c) =>
                  onSelectionChange(c ? new Set(files.map((f) => f.id)) : new Set())
                }
              />
            </th>
            {COLUMNS.map((col) => {
              const SortIcon = sort.key !== col.key ? ChevronsUpDown : sort.dir === "asc" ? ChevronUp : ChevronDown;
              return (
                <th key={col.key} className={cn("px-3 py-2.5", col.className)}>
                  <button
                    onClick={() => onSort(col.key)}
                    className={cn(
                      "inline-flex items-center gap-1 text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {col.label}
                    <SortIcon size={13} className={sort.key === col.key ? "text-foreground" : "opacity-50"} />
                  </button>
                </th>
              );
            })}
            <th className="w-10" />
          </tr>
        </thead>
        <tbody>
          {files.map((f, i) => {
            const selected = selection.has(f.id);
            const pluginItems = readOnly ? [] : pluginMenuItems(f.kind);
            const actions = actionsFor(f, readOnly, trashed);
            return (
              <ContextMenu key={f.id}>
                <ContextMenuTrigger asChild>
                  <tr
                    {...rowFocus(i)}
                    {...dragHandlers(f)}
                    {...dropHandlers(f)}
                    onClick={(e) => handleRowClick(e, i, f.id)}
                    onDoubleClick={() => onOpen(f)}
                    className={cn(
                      "focus-visible:outline-2 focus-visible:outline-primary group cursor-default border-t transition-colors",
                      dragOverId === f.id
                        ? "bg-primary/10 ring-2 ring-inset ring-primary"
                        : selected
                          ? "bg-primary/[0.06]"
                          : "hover:bg-muted/50",
                    )}
                    style={{ height: "var(--row-h)" }}
                  >
                    <td className="px-3">
                      <Checkbox
                        checked={selected}
                        onClick={(e) => e.stopPropagation()}
                        onCheckedChange={() => {
                          const next = new Set(selection);
                          if (next.has(f.id)) next.delete(f.id);
                          else next.add(f.id);
                          onSelectionChange(next);
                        }}
                      />
                    </td>
                    <td className="min-w-0 px-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <FileIcon kind={f.kind} />
                        <div className="min-w-0"><span className="block max-w-[calc(100vw-9rem)] truncate font-medium md:max-w-none">{searchQuery ? <SearchHighlight text={f.name} query={searchQuery} mode="prefix" /> : f.name}</span>
                          {f.description ? <p className="line-clamp-2 [overflow-wrap:anywhere] text-xs text-muted-foreground">{searchQuery && f.snippet ? <SearchHighlight text={f.snippet} query={searchQuery} mode="substring" /> : f.description}</p> : null}
                        </div>
                      </div>
                    </td>
                    <td className="hidden px-3 font-mono text-[12.5px] text-muted-foreground md:table-cell">{f.modified}</td>
                    <td className="px-2">
                      <RowActions file={f} onAction={onAction} readOnly={readOnly} trashed={trashed} />
                    </td>
                  </tr>
                </ContextMenuTrigger>
                {actions.length > 0 || pluginItems.length > 0 ? (
                <ContextMenuContent className="w-48">
                  {actions.map((a) =>
                    a === "Open" ? (
                      // Open is the double-click, so it goes straight there rather than
                      // through `onAction` — the one item with a shorter path.
                      <ContextMenuItem key={a} onSelect={() => onOpen(f)}>
                        Open
                      </ContextMenuItem>
                    ) : (
                      <ContextMenuItem
                        key={a}
                        variant={a === "Delete" ? "destructive" : undefined}
                        onSelect={() => onAction(a, f)}
                      >
                        {a}
                      </ContextMenuItem>
                    ),
                  )}
                  {pluginItems.length > 0 && <ContextMenuSeparator />}
                  {pluginItems.map((item) => (
                    <ContextMenuItem key={item.pluginId + item.label} onSelect={() => onAction(item.label, f)}>
                      {item.icon && <Icon name={item.icon} size={15} />}
                      {item.label}
                    </ContextMenuItem>
                  ))}
                </ContextMenuContent>
                ) : null}
              </ContextMenu>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
