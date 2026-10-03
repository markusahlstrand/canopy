import type { SearchHit } from './api';
export type MatchFilter = 'all' | SearchHit['via'];
export const filterMatches = (hits: SearchHit[], filter: MatchFilter) => filter === 'all' ? hits : hits.filter(hit => hit.via === filter);
export function SearchMatchFilter({ hits, value, onChange, busy = false }: { hits: SearchHit[]; value: MatchFilter; busy?: boolean; onChange: (value: MatchFilter) => void }) {
  return <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
    <label>Match type <select aria-label="Filter search matches" value={value} className="rounded border border-border bg-background p-1" onChange={event => onChange(event.target.value as MatchFilter)}>
      <option value="all">All matches</option><option value="name">File name</option><option value="content">File contents</option><option value="metadata">Descriptions and labels</option>
    </select></label>
    <p role="status" className="text-xs text-muted-foreground">{busy ? 'Loading matches…' : `Showing ${filterMatches(hits, value).length} of ${hits.length} returned matches.`} The server searches the selected field before returning up to 50 files. A file may match more than one field.</p>
  </div>;
}
