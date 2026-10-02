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
} from "@canopy/ui";
import { Icon } from "@canopy/ui";
import { FileIcon } from "./file-icon";
import { SEARCH_MIN, search, type SearchHit } from "./api";
import { kindOf, type FileItem } from "./items";

/**
 * Where the palette can take you.
 *
 * The portal's list had Home, Family and Starred as well. This drive has one space per
 * install with a switcher of its own, and neither starred nor a home dashboard exists —
 * so the list is what the screen can actually show.
 */
const NAV = [
  { id: "drive", icon: "my-drive", label: "My Drive", shortcut: "G D" },
  { id: "trash", icon: "trash", label: "Trash", shortcut: "G T" },
];

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The current folder's rows — the zero-query list, before anything is typed. */
  files: FileItem[];
  onNavigate: (id: string) => void;
  onOpenFile: (f: FileItem) => void;
  /** Upload, which the toolbar also offers; the palette is the keyboard path to it. */
  onUpload: () => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  files,
  onNavigate,
  onOpenFile,
  onUpload,
}: CommandPaletteProps) {
  const run = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };

  // Full-text search across the drive (name + body + labels), server-side. The
  // local `files` (current folder) are the zero-query "recent" fallback.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const searching = query.trim().length >= SEARCH_MIN;

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
      // A failure here leaves the previous results rather than throwing inside a dialog:
      // the palette is a search box, and an empty list is the honest answer to a search
      // that did not come back.
      const hits = await search(query).catch(() => ({ hits: [] }));
      if (!cancelled) setResults(hits.hits);
    }, 180); // debounce keystrokes
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, searching]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} className="top-[18%] translate-y-0">
      <CommandInput
        placeholder="Search files and more…"
        value={query}
        onValueChange={(next) => {
          setQuery(next);
          // The previous query's hits are wrong the moment the query changes — and worse
          // than wrong, because cmdk's `value` embeds the new query, so they stay
          // selectable and open an unrelated file.
          setResults([]);
        }}
      />
      <CommandList className="max-h-[60vh]">
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Files">
          {searching
            ? results.map((hit) => (
                // value embeds the query so cmdk's own filter keeps server hits visible.
                <CommandItem
                  key={hit.id}
                  value={`hit ${query} ${hit.name}`}
                  onSelect={run(() =>
                    onOpenFile({
                      id: hit.id,
                      name: hit.name,
                      kind: kindOf(null),
                      modified: '',
                      size: '—',
                      isFolder: false,
                    }),
                  )}
                >
                  <FileIcon kind={kindOf(null)} size={22} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{hit.name}</span>
                    {/* What extraction bought: matching a document's text reads
                        differently to matching its name. */}
                    <span className="truncate text-[11.5px] text-muted-foreground">
                      {hit.snippet || (hit.via === 'content' ? 'matched inside the document' : hit.via === 'metadata' ? 'matched in description or labels' : 'matched in the name')}
                    </span>
                  </span>
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
        {/* One action, because one action has an operation behind it. The plugin store,
            the theme toggle and settings were in this group and are not here: the store
            is #73's to answer, and the other two have nothing to toggle or show. */}
        <CommandGroup heading="Actions">
          <CommandItem value="upload" onSelect={run(onUpload)}>
            <Icon name="upload" size={16} />
            <span className="flex-1">Upload</span>
            <CommandShortcut>⌘U</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
