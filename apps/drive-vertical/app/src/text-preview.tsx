import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
export function TextPreview({ text, wrap, onWrapChange }: { text: string; wrap: boolean; onWrapChange: (wrap: boolean) => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const current = useRef<HTMLElement | null>(null);
  const { matches, limited } = useMemo(() => findMatches(text, query), [text, query]);
  const index = Math.min(active, Math.max(0, matches.length - 1));
  useEffect(() => setActive(0), [text, query]);
  useEffect(() => { current.current?.scrollIntoView?.({ block: 'nearest' }); }, [index, query, text]);
  const advance = (direction: number) => { if (matches.length) setActive((index + direction + matches.length) % matches.length); };
  const fragments: ReactNode[] = [];
  let offset = 0;
  matches.forEach((match, i) => {
    fragments.push(text.slice(offset, match.start));
    fragments.push(<mark key={match.start} ref={i === index ? current : undefined} aria-current={i === index ? 'true' : undefined}
      className={i === index ? 'bg-primary text-primary-foreground' : 'bg-accent text-accent-foreground'}>{text.slice(match.start, match.end)}</mark>);
    offset = match.end;
  });
  fragments.push(text.slice(offset));
  return <div className="min-w-0 space-y-2">
    <Button size="sm" variant="outline" aria-pressed={wrap} onClick={() => onWrapChange(!wrap)}>Wrap lines</Button>
    <div className="flex flex-wrap items-center gap-1">
      <Input type="search" aria-label="Find in file" placeholder="Find in file" maxLength={200} className="h-8 min-w-0 flex-1" value={query}
        onChange={event => setQuery(event.target.value)} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') { event.preventDefault(); advance(event.shiftKey ? -1 : 1); }
          if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery(''); }
        }} />
      <Button size="sm" variant="ghost" disabled={!matches.length} aria-label="Previous match" onClick={() => advance(-1)}>↑</Button>
      <Button size="sm" variant="ghost" disabled={!matches.length} aria-label="Next match" onClick={() => advance(1)}>↓</Button>
    </div>
    {query ? <p role="status" className="text-xs text-muted-foreground">{matches.length ? `${index + 1} of ${matches.length}${limited ? '+' : ''} matches` : 'No matches'}{limited ? ' · Showing the first 1,000 matches' : ''}</p> : null}
    <pre className={wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere] text-xs' : 'overflow-x-auto whitespace-pre text-xs'}>{fragments}</pre>
  </div>;
}
