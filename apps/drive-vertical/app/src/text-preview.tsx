import { TextStatistics } from './text-statistics';
import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Input } from '@canopy/ui';

const MATCH_LIMIT = 1000;
/** Literal Unicode-aware matching, bounded to keep repetitive files cheap to render. */
function findMatches(text: string, query: string) {
  const matches: { start: number; end: number }[] = [];
  if (!query) return { matches, limited: false };
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  for (const match of text.matchAll(pattern)) {
    if (matches.length === MATCH_LIMIT) return { matches, limited: true };
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return { matches, limited: false };
}

/** Display plain text with local find controls; finding never fetches or edits bytes. */
export function TextPreview({ text, wrap, onWrapChange, truncated = false }: { text: string; wrap: boolean; onWrapChange: (wrap: boolean) => void; truncated?: boolean }) {
  const [query, setQuery] = useState('');
  const searchQuery = useDeferredValue(query);
  const pending = searchQuery !== query;
  const [navigation, setNavigation] = useState({ text, query: '', index: 0 });
  const current = useRef<HTMLElement | null>(null);
  const toolbar = useRef<HTMLDivElement | null>(null);
  const [toolbarHeight, setToolbarHeight] = useState(96);
  const { matches, limited } = useMemo(() => findMatches(text, searchQuery), [text, searchQuery]);
  // New queries reset during the input event; new text resets in this same render.
  const active = navigation.text === text && navigation.query === searchQuery ? navigation.index : 0;
  const index = Math.min(active, Math.max(0, matches.length - 1));
  useLayoutEffect(() => {
    const measure = () => setToolbarHeight(toolbar.current?.getBoundingClientRect().height || 96);
    measure();
    if (typeof ResizeObserver === 'undefined' || !toolbar.current) return;
    const observer = new ResizeObserver(measure); observer.observe(toolbar.current);
    return () => observer.disconnect();
  }, [query, pending, limited]);
  useEffect(() => {
    if (!pending) current.current?.scrollIntoView?.({ block: 'nearest' });
  }, [index, searchQuery, text, pending, toolbarHeight]);
  const changeQuery = (value: string) => { setQuery(value); setNavigation({ text, query: value, index: 0 }); };
  const advance = (direction: number) => {
    if (!pending && matches.length) setNavigation({ text, query: searchQuery, index: (index + direction + matches.length) % matches.length });
  };
  const fragments = useMemo(() => {
    const nodes: ReactNode[] = [];
    let offset = 0;
    matches.forEach((match, i) => {
      nodes.push(text.slice(offset, match.start));
      nodes.push(<mark key={match.start} ref={i === index ? current : undefined} aria-current={i === index ? 'true' : undefined}
        style={{ scrollMarginTop: toolbarHeight + 8 }}
        className={i === index ? 'bg-primary text-primary-foreground' : 'bg-accent text-accent-foreground'}>{text.slice(match.start, match.end)}</mark>);
      offset = match.end;
    });
    nodes.push(text.slice(offset));
    return nodes;
  }, [text, matches, index, toolbarHeight]);
  return <div className="min-w-0 space-y-2">
    <div ref={toolbar} className="sticky top-0 z-10 space-y-2 bg-background pb-2">
      <Button size="sm" variant="outline" aria-pressed={wrap} onClick={() => onWrapChange(!wrap)}>Wrap lines</Button>
      <div className="flex flex-wrap items-center gap-1">
        <Input type="search" aria-label="Find in file" placeholder="Find in file" maxLength={200} className="h-8 min-w-0 flex-1" value={query}
          onChange={event => changeQuery(event.target.value)} onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter') { event.preventDefault(); advance(event.shiftKey ? -1 : 1); }
            if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); changeQuery(''); }
          }} />
        <Button size="sm" variant="ghost" disabled={pending || !matches.length} aria-label="Previous match" onClick={() => advance(-1)}>↑</Button>
        <Button size="sm" variant="ghost" disabled={pending || !matches.length} aria-label="Next match" onClick={() => advance(1)}>↓</Button>
      </div>
      {query ? <p role="status" className="text-xs text-muted-foreground">{pending ? 'Updating matches…' : matches.length ? `${index + 1} of ${matches.length}${limited ? '+' : ''} matches` : 'No matches'}{!pending && limited ? ' · Showing the first 1,000 matches' : ''}</p> : null}
      <TextStatistics text={text} truncated={truncated} />
    </div>
    <pre aria-busy={pending} className={wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere] text-xs' : 'overflow-x-auto whitespace-pre text-xs'}>{fragments}</pre>
  </div>;
}
