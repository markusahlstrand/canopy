import { useRef } from "react";
import { ChevronUp, ChevronDown, ChevronsUpDown, Star } from "lucide-react";
import type { FileItem } from "@/lib/mock-data";
import { FileIcon } from "@/components/file-icon";
import { AvatarGroup } from "@/components/person-avatar";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { FileKind } from "@/lib/mock-data";

export interface PluginMenuItem {
  pluginId: string;
  label: string;
  icon?: string;
}

export type SortKey = "name" | "shared" | "modified" | "size";
export interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}

interface FileTableProps {
  files: FileItem[];
  selection: Set<number>;
  onSelectionChange: (s: Set<number>) => void;
  onOpen: (f: FileItem) => void;
  sort: SortState;
  onSort: (key: SortKey) => void;
  view: "list" | "grid";
  onAction: (action: string, f: FileItem) => void;
  pluginMenuItems: (kind: FileKind) => PluginMenuItem[];
}

const COLUMNS: { key: SortKey; label: string; className: string }[] = [
  { key: "name", label: "Name", className: "" },
  { key: "shared", label: "Shared", className: "w-[132px]" },
  { key: "modified", label: "Modified", className: "w-[124px]" },
  { key: "size", label: "Size", className: "w-[96px] text-right" },
];

const STD_ACTIONS = ["Open", "Download", "Share", "Copy link"];

function RowActions({ file, onAction }: { file: FileItem; onAction: (action: string, f: FileItem) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          onClick={(e) => e.stopPropagation()}
          className="grid size-7 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100 data-[state=open]:opacity-100"
        >
          <Icon name="more" size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44" onClick={(e) => e.stopPropagation()}>
        {STD_ACTIONS.map((a) => (
          <DropdownMenuItem key={a} onSelect={() => onAction(a, file)}>
            {a}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onAction("Rename", file)}>Rename</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAction("Star", file)}>Star</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAction("Move", file)}>Move</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => onAction("Delete", file)}>
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function FileTable({
  files,
  selection,
  onSelectionChange,
  onOpen,
  sort,
  onSort,
  view,
  onAction,
  pluginMenuItems,
}: FileTableProps) {
  const lastIndex = useRef<number | null>(null);

  function handleRowClick(e: React.MouseEvent, index: number, id: number) {
    const next = new Set(selection);
    if (e.shiftKey && lastIndex.current != null) {
      const [a, b] = [lastIndex.current, index].sort((x, y) => x - y);
      for (let i = a; i <= b; i++) next.add(files[i]!.id);
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
  }

  const allSelected = files.length > 0 && files.every((f) => selection.has(f.id));

  if (view === "grid") {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
        {files.map((f) => (
          <div
            key={f.id}
            onClick={(e) => handleRowClick(e, files.indexOf(f), f.id)}
            onDoubleClick={() => onOpen(f)}
            className={cn(
              "group flex cursor-default flex-col gap-2.5 rounded-lg border p-3.5 transition-colors",
              selection.has(f.id) ? "border-primary/40 bg-primary/[0.06]" : "hover:bg-muted/50",
            )}
          >
            <div className="flex items-start justify-between">
              <FileIcon kind={f.kind} size={38} />
              {f.starred && <Star size={14} className="fill-warning text-warning" />}
            </div>
            <div className="truncate text-[13.5px] font-medium">{f.name}</div>
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11.5px] text-muted-foreground">{f.modified}</span>
              {f.sharedWith && <AvatarGroup people={f.sharedWith} max={2} />}
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
                      col.key === "size" && "flex-row-reverse",
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
            const pluginItems = pluginMenuItems(f.kind);
            return (
              <ContextMenu key={f.id}>
                <ContextMenuTrigger asChild>
                  <tr
                    onClick={(e) => handleRowClick(e, i, f.id)}
                    onDoubleClick={() => onOpen(f)}
                    className={cn(
                      "group cursor-default border-t transition-colors",
                      selected ? "bg-primary/[0.06]" : "hover:bg-muted/50",
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
                    <td className="px-3">
                      <div className="flex items-center gap-3">
                        <FileIcon kind={f.kind} />
                        <span className="truncate font-medium">{f.name}</span>
                        {f.starred && <Star size={13} className="shrink-0 fill-warning text-warning" />}
                      </div>
                    </td>
                    <td className="px-3">
                      {f.sharedWith && f.sharedWith.length > 0 ? (
                        <AvatarGroup people={f.sharedWith} />
                      ) : (
                        <span className="text-[13px] text-muted-foreground">Only you</span>
                      )}
                    </td>
                    <td className="px-3 font-mono text-[12.5px] text-muted-foreground">{f.modified}</td>
                    <td className="px-3 text-right font-mono text-[12.5px] text-muted-foreground">{f.size}</td>
                    <td className="px-2">
                      <RowActions file={f} onAction={onAction} />
                    </td>
                  </tr>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-48">
                  <ContextMenuItem onSelect={() => onOpen(f)}>Open</ContextMenuItem>
                  <ContextMenuItem onSelect={() => onAction("Download", f)}>Download</ContextMenuItem>
                  <ContextMenuItem onSelect={() => onAction("Share", f)}>Share</ContextMenuItem>
                  <ContextMenuItem onSelect={() => onAction("Copy link", f)}>Copy link</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => onAction("Rename", f)}>Rename</ContextMenuItem>
                  <ContextMenuItem onSelect={() => onAction("Star", f)}>Star</ContextMenuItem>
                  <ContextMenuItem onSelect={() => onAction("Move", f)}>Move</ContextMenuItem>
                  {pluginItems.length > 0 && <ContextMenuSeparator />}
                  {pluginItems.map((item) => (
                    <ContextMenuItem key={item.pluginId + item.label} onSelect={() => onAction(item.label, f)}>
                      {item.icon && <Icon name={item.icon} size={15} />}
                      {item.label}
                    </ContextMenuItem>
                  ))}
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" onSelect={() => onAction("Delete", f)}>
                    Delete
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
