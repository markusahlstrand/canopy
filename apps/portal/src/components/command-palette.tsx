import { useEffect, useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/lib/icons";
import { FileIcon } from "@/components/file-icon";
import { searchFiles, type SearchResult } from "@/lib/api";
import { PLUGIN_CATALOG, type FileItem } from "@/lib/mock-data";

const NAV = [
  { id: "home", icon: "home", label: "Home", shortcut: "G H" },
  { id: "drive", icon: "my-drive", label: "My Drive", shortcut: "G D" },
  { id: "family", icon: "family", label: "Family", shortcut: "G F" },
  { id: "starred", icon: "starred", label: "Starred", shortcut: "G S" },
  { id: "trash", icon: "trash", label: "Trash", shortcut: "G T" },
];

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: FileItem[];
  installedIds: string[];
  onNavigate: (id: string) => void;
  onOpenFile: (f: FileItem) => void;
  onOpenStore: () => void;
  onToggleTheme: () => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  files,
  installedIds,
  onNavigate,
  onOpenFile,
  onOpenStore,
  onToggleTheme,
}: CommandPaletteProps) {
  const run = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };

  // Full-text search across the drive (name + body + labels), server-side. The
  // local `files` (current folder) are the zero-query "recent" fallback.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const searching = query.trim().length >= 2;

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
    }
  }, [open]);

  useEffect(() => {
    if (!searching) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const hits = await searchFiles(query);
      if (!cancelled) setResults(hits);
    }, 180); // debounce keystrokes
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, searching]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} className="top-[18%] translate-y-0">
      <CommandInput placeholder="Search files and more…" value={query} onValueChange={setQuery} />
      <CommandList className="max-h-[60vh]">
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Files">
          {searching
            ? results.map((r) => (
                // value embeds the query so cmdk's own filter keeps server hits visible.
                <CommandItem key={r.file.id} value={`hit ${query} ${r.file.name}`} onSelect={run(() => onOpenFile(r.file))}>
                  <FileIcon kind={r.file.kind} size={22} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{r.file.name}</span>
                    {r.snippet && <span className="truncate text-[11.5px] text-muted-foreground">{r.snippet}</span>}
                  </span>
                  <span className="font-mono text-[11.5px] text-muted-foreground">{r.file.modified}</span>
                </CommandItem>
              ))
            : files.slice(0, 6).map((f) => (
                <CommandItem key={f.id} value={`file ${f.name}`} onSelect={run(() => onOpenFile(f))}>
                  <FileIcon kind={f.kind} size={22} />
                  <span className="flex-1">{f.name}</span>
                  <span className="font-mono text-[11.5px] text-muted-foreground">{f.modified}</span>
                </CommandItem>
              ))}
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="Navigate">
          {NAV.map((n) => (
            <CommandItem key={n.id} value={`go ${n.label}`} onSelect={run(() => onNavigate(n.id))}>
              <Icon name={n.icon} size={16} />
              <span className="flex-1">{n.label}</span>
              <CommandShortcut>{n.shortcut}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="Plugins">
          {PLUGIN_CATALOG.map((p) => (
            <CommandItem
              key={p.id}
              value={`plugin ${p.label}`}
              onSelect={run(() =>
                installedIds.includes(p.id) ? onNavigate(`plugin:${p.id}`) : onOpenStore(),
              )}
            >
              <Icon name={p.icon} size={16} />
              <span className="flex-1">{p.label}</span>
              {installedIds.includes(p.id) && (
                <Badge variant="secondary" className="text-[10px]">
                  Installed
                </Badge>
              )}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem value="upload" onSelect={run(() => {})}>
            <Icon name="upload" size={16} />
            <span className="flex-1">Upload</span>
            <CommandShortcut>⌘U</CommandShortcut>
          </CommandItem>
          <CommandItem value="browse plugin store" onSelect={run(onOpenStore)}>
            <Icon name="plugin" size={16} />
            <span className="flex-1">Browse plugin store</span>
          </CommandItem>
          <CommandItem value="toggle theme" onSelect={run(onToggleTheme)}>
            <Icon name="moon" size={16} />
            <span className="flex-1">Toggle theme</span>
            <CommandShortcut>⌘J</CommandShortcut>
          </CommandItem>
          <CommandItem value="settings" onSelect={run(() => {})}>
            <Icon name="settings" size={16} />
            <span className="flex-1">Settings</span>
            <CommandShortcut>⌘,</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
