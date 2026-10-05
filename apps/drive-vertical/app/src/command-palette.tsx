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
import { SearchHighlight } from "./search-highlight";
import { FileIcon } from "./file-icon";
import { SEARCH_MIN, search, type PluginInstall, type SearchHit, type Site } from "./api";
import { pluginManifest } from './installed-plugins';
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
  { id: "search", icon: "search", label: "Search this space", shortcut: "" },
  { id: "shared", icon: "users", label: "Shared with me", shortcut: "" },
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
  sites?: Site[];
  onOpenSpace?: (slug: string) => void;
  pluginApps?: PluginInstall[];
  onOpenPlugin?: (id: string) => void;
  onManageSpaces?: () => void;
  onManagePlugins?: () => void;
}

/** Search and keyboard actions, with visible progress and recoverable failures. */
export function CommandPalette({
  open,
  onOpenChange,
  files,
  onNavigate,
  onOpenFile,
  onUpload,
  sites = [],
  onOpenSpace,
  pluginApps = [],
  onOpenPlugin,
  onManageSpaces,
  onManagePlugins,
}: CommandPaletteProps) {
  const run = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };

  // Full-text search across the drive (name + body + labels), server-side. The
  // local `files` (current folder) are the zero-query "recent" fallback.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [settledQuery, setSettledQuery] = useState<string | null>(null);
  const searching = query.trim().length >= SEARCH_MIN;

  useEffect(() => {
    if (!open) {
      setQuery("");
      setSettledQuery(null);
      setResults([]);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !searching) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const t = setTimeout(async () => {
      try {
        const hits = await search(query);
        if (!cancelled) setResults(hits.hits);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message || 'Search failed.' : String(e));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setSettledQuery(query);
        }
      }
    }, 180);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, searching, open, retry]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} className="top-[18%] translate-y-0">
      <CommandInput
        placeholder="Search files and more…"
        value={query}
        onValueChange={(next) => {
          setQuery(next);
          setSettledQuery(null);
          // The previous query's hits are wrong the moment the query changes — and worse
          // than wrong, because cmdk's `value` embeds the new query, so they stay
          // selectable and open an unrelated file.
          setResults([]);
          setError(null);
        }}
      />
      <CommandList className="max-h-[60vh]">
        {error ? <>
          <p role="alert" className="p-3 text-sm">{error}</p>
          <CommandItem value={`retry ${query}`} onSelect={() => {
            setSettledQuery(null);
            setRetry(value => value + 1);
          }}>Retry search</CommandItem>
        </> : null}
        {searching && loading ? <p role="status" className="p-3 text-sm">Searching…</p> : null}

        {(!searching || settledQuery === query) && !loading && !error ? <CommandEmpty>No results found.</CommandEmpty> : null}

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
                    <span className="truncate"><SearchHighlight text={hit.name} query={query} mode="prefix" /></span>
                    {/* What extraction bought: matching a document's text reads
                        differently to matching its name. */}
                    <span className="truncate text-[11.5px] text-muted-foreground">
                      {hit.snippet ? <SearchHighlight text={hit.snippet} query={query} mode="substring" /> : (hit.via === 'content' ? 'matched inside the document' : hit.via === 'metadata' ? 'matched in description or labels' : 'matched in the name')}
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

        {onOpenSpace && sites.length ? <>
          <CommandSeparator />
          <CommandGroup heading="Spaces">
            {sites.map(site => <CommandItem key={site.slug} value={`space ${site.name} ${site.slug}`} onSelect={run(() => { if (!site.current) onOpenSpace(site.slug); })}>
              <Icon name={site.icon ?? 'users'} size={16} style={{ color: site.color }} />
              <span className="min-w-0 flex-1 truncate">{site.name}</span>
              {site.current ? <span className="text-xs text-muted-foreground">Current</span> : null}
            </CommandItem>)}
          </CommandGroup>
        </> : null}

        {onOpenPlugin && pluginApps.length ? <>
          <CommandSeparator />
          <CommandGroup heading="Apps">
            {pluginApps.map(row => {
              const manifest = pluginManifest(row);
              return <CommandItem key={row.id} value={`app ${manifest.name} ${manifest.contributes.detailView?.title ?? ''}`} onSelect={run(() => onOpenPlugin(row.id))}>
                <Icon name="plugin" size={16} />
                <span className="min-w-0 flex-1 truncate">{manifest.contributes.detailView?.title ?? manifest.name}</span>
              </CommandItem>;
            })}
          </CommandGroup>
        </> : null}

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
        <CommandGroup heading="Actions">
          {onManageSpaces ? <CommandItem value="manage spaces" onSelect={run(onManageSpaces)}>
            <Icon name="users" size={16} /><span className="flex-1">Manage spaces</span>
          </CommandItem> : null}
          {onManagePlugins ? <CommandItem value="manage plugins" onSelect={run(onManagePlugins)}>
            <Icon name="plugin" size={16} /><span className="flex-1">Manage plugins</span>
          </CommandItem> : null}
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
