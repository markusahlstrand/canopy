import { useEffect, useMemo, useRef, useState } from "react";
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
import { SEARCH_MIN, askAssistant, search, type AssistantSource, type PluginInstall, type SearchHit, type Site } from "./api";
import { AssistantThread, type AssistantTurn } from "./assistant-thread";
import { historyWindow, MAX_QUESTION_CHARS } from "../../src/assistant-contract";
import { pluginManifest } from './installed-plugins';
import { kindOf, type FileItem } from "./items";
import { openSpaceFile, spaceLabel } from './space-navigation';

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
  onNavigate: (id: string) => boolean | void;
  onOpenFile: (f: FileItem) => boolean | void;
  /** Upload, which the toolbar also offers; the palette is the keyboard path to it. */
  onUpload?: () => void;
  sites?: Site[];
  onOpenSpace?: (slug: string) => boolean | void;
  pluginApps?: PluginInstall[];
  onOpenPlugin?: (id: string) => boolean | void;
  onManageSpaces?: () => void;
  onManagePlugins?: () => void;
  onShowAllResults?: (query: string) => boolean | void;
  offline?: boolean;
}

/** A file the palette knows only by id and name — a search hit or an assistant source. */
const fileStub = (id: string, name: string): FileItem => ({ id, name, kind: kindOf(null, name), modified: '', size: '—', isFolder: false });

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
  onShowAllResults,
  offline = false,
}: CommandPaletteProps) {
  const run = (fn: () => boolean | void) => () => {
    if (fn() !== false) onOpenChange(false);
  };

  // Full-text search across the drive (name + body + labels), server-side. The
  // local `files` (current folder) are the zero-query "recent" fallback.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [settledQuery, setSettledQuery] = useState<string | null>(null);
  // The assistant: its conversation outlives the dialog, so ⌘K, Esc, ⌘K comes back to it.
  const [mode, setMode] = useState<'search' | 'assistant'>('search');
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  // A question refused before it was sent: said beside the box, cleared as it is edited.
  const [askNotice, setAskNotice] = useState<string | null>(null);
  // Bumped by "New conversation", so an answer to the old one cannot land in the new one.
  const conversation = useRef(0);
  const assistant = mode === 'assistant' && !offline;
  const searching = !assistant && !offline && query.trim().length >= SEARCH_MIN;

  const send = (history: AssistantTurn[]) => {
    const id = conversation.current;
    setAsking(true);
    setAskError(null);
    askAssistant(historyWindow(history).map(({ role, content }) => ({ role, content })))
      .then((reply) => {
        if (id === conversation.current) setTurns([...history, { role: 'assistant', content: reply.answer, sources: reply.sources }]);
      })
      .catch((e: unknown) => {
        if (id === conversation.current) setAskError(e instanceof Error ? e.message || 'The assistant could not answer.' : String(e));
      })
      .finally(() => {
        if (id === conversation.current) setAsking(false);
      });
  };
  /** `fresh`: asked from search, which reads as a new question — "Continue" is how to go on. */
  const ask = (question: string, fresh = false) => {
    const text = question.trim();
    // One question at a time: a follow-up typed while an answer is coming stays in the box.
    // A fresh question retires one still pending; a follow-up waits for it.
    if (!text) { setMode('assistant'); return; }
    if (asking && !fresh) return;
    // Refused here, with the text still in the box: the worker would refuse it anyway, and
    // a retry of a turn that can never be accepted is a dead end. Before any reset, so a
    // refused question costs nothing — the conversation is kept, minus its stale Retry.
    if (text.length > MAX_QUESTION_CHARS) {
      // A notice, not the request error: it is about the text in the box, and goes as it is edited.
      setAskNotice(`Ask a question of at most ${MAX_QUESTION_CHARS.toLocaleString('en')} characters.`);
      return;
    }
    setMode('assistant');
    // A fresh question leaves the old conversation, so its errors and Retry go too.
    if (fresh) resetConversation();
    setQuery('');
    setResults([]);
    // A question whose answer failed is replaced by the next one, not left unanswered
    // above it: two questions in a row is not a conversation a model can read.
    const base = fresh ? [] : turns;
    const settled = base.at(-1)?.role === 'user' ? base.slice(0, -1) : base;
    const history = [...settled, { role: 'user' as const, content: text }];
    setTurns(history);
    send(history);
  };
  const resetConversation = () => {
    conversation.current++;
    setTurns([]);
    setAsking(false);
    setAskError(null);
  };
  const here = sites.find((site) => site.current)?.slug;
  const spaceNames = useMemo(() => new Map(sites.map((site) => [site.slug, spaceLabel(site)])), [sites]);
  const openSource = (source: AssistantSource) => {
    // Unknown here is "another space": a page load to the right one is always correct,
    // opening by id in the wrong one never is.
    if (here && source.space === here) {
      if (onOpenFile(fileStub(source.fileId, source.name)) !== false) onOpenChange(false);
      return;
    }
    // Another space is another page load, behind the same draft guard as switching spaces.
    openSpaceFile(source.space, source.fileId);
  };

  useEffect(() => {
    if (!open) {
      // A conversation outlives the dialog: ⌘K, Esc, ⌘K comes back to it.
      setMode(turns.length || asking ? 'assistant' : 'search');
      setAskNotice(null);
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
  }, [query, searching, open, retry, offline]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} className="top-[18%] translate-y-0">
      <CommandInput
        placeholder={assistant ? (turns.length ? "Ask a follow-up…" : "Ask about your documents…") : "Search files, or ask the assistant…"}
        value={query}
        onKeyDown={(event) => {
          // Enter that confirms an IME candidate is composing, not sending. Safari reports
          // that keydown with isComposing false and keyCode 229.
          if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229 || offline) return;
          // In the assistant, Enter sends. In search, ⌘↵ hands the query to the assistant
          // and a plain Enter still opens the highlighted result.
          if (assistant || event.metaKey || event.ctrlKey) {
            event.preventDefault();
            event.stopPropagation();
            ask(query, !assistant);
          }
        }}
        onValueChange={(next) => {
          setQuery(next);
          setAskNotice(null);
          setSettledQuery(null);
          // The previous query's hits are wrong the moment the query changes — and worse
          // than wrong, because cmdk's `value` embeds the new query, so they stay
          // selectable and open an unrelated file.
          setResults([]);
          setError(null);
        }}
      />
      <CommandList className="max-h-[60vh]">
        {assistant ? <AssistantThread
          turns={turns}
          asking={asking}
          error={askError}
          // Retry resends an unanswered question; an error with nothing to resend has none.
          onRetry={turns.at(-1)?.role === 'user' ? () => send(turns) : undefined}
          onOpenSource={openSource}
          spaceNames={spaceNames}
          currentSpace={here}
          onBack={() => setMode('search')}
          onReset={resetConversation}
        /> : <>
        {offline ? <p role="status" className="p-3 text-sm text-muted-foreground">File search is unavailable while offline. Reconnect to search this space.</p> : null}
        {error ? <>
          <p role="alert" className="p-3 text-sm">{error}</p>
          <CommandItem value={`retry ${query}`} onSelect={() => {
            setSettledQuery(null);
            setRetry(value => value + 1);
          }}>Retry search</CommandItem>
        </> : null}
        {searching && loading ? <p role="status" className="p-3 text-sm">Searching…</p> : null}

        {(!searching || settledQuery === query) && !loading && !error ? <CommandEmpty>{offline ? 'File search is unavailable while offline.' : query.trim() && !searching
          ? `Type at least ${SEARCH_MIN} characters to search files.` : 'No results found.'}</CommandEmpty> : null}

        <CommandGroup heading="Files">
          {searching && onShowAllResults ? <CommandItem value={`show all search results ${query}`} onSelect={run(() => onShowAllResults(query.trim()))}>
            <Icon name="search" size={16} />
            <span className="flex-1">Show all results for “{query.trim()}”</span>
          </CommandItem> : null}
          {searching
            ? results.map((hit) => (
                // value embeds the query so cmdk's own filter keeps server hits visible.
                <CommandItem
                  key={hit.id}
                  value={`hit ${query} ${hit.name}`}
                  onSelect={run(() =>
                    onOpenFile(fileStub(hit.id, hit.name)),
                  )}
                >
                  <FileIcon kind={kindOf(null, hit.name)} size={22} />
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
            {sites.map(site => <CommandItem key={site.slug} value={`space ${spaceLabel(site)} ${site.slug}`} onSelect={run(() => site.current ? undefined : onOpenSpace(site.slug))}>
              <Icon name={site.icon ?? 'users'} size={16} style={{ color: site.color }} />
              <span className="min-w-0 flex-1 truncate">{spaceLabel(site)}</span>
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
          {NAV.filter(n => !offline || n.id === 'drive').map((n) => (
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
          {onUpload ? <CommandItem value="upload" onSelect={run(onUpload)}>
            <Icon name="upload" size={16} />
            <span className="flex-1">Upload</span>
            <CommandShortcut>⌘U</CommandShortcut>
          </CommandItem> : null}
        </CommandGroup>
        </>}
      </CommandList>
      {/* Not a cmdk item, on purpose: an item matching every query would outrank file hits
          and take a plain Enter. Asking is ⌘↵, a click, or Tab to this button. */}
      {!offline && askNotice ? <p role="alert" className="border-t px-4 py-2 text-sm">{askNotice}</p> : null}
      {!offline && !assistant ? <button
        type="button"
        onClick={() => query.trim() ? ask(query, true) : setMode('assistant')}
        className="flex w-full items-center gap-2 border-t px-4 py-2.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
      >
        <Icon name="sparkles" size={16} />
        <span className="min-w-0 flex-1 truncate">
          {query.trim()
            // Said outright: from here a question starts over, and "Continue" is how to go on.
            ? <>{turns.length ? 'Ask in a new conversation' : 'Ask the assistant'}: “{query.trim()}”</>
            : turns.length ? 'Continue the conversation' : 'Ask the assistant…'}
        </span>
        {query.trim() ? <CommandShortcut>⌘↵</CommandShortcut> : null}
      </button> : null}
    </CommandDialog>
  );
}
