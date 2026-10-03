import type { SearchHit } from './api';
export type MatchFilter = 'all' | SearchHit['via'];
export const filterMatches = (hits: SearchHit[], filter: MatchFilter) => filter === 'all' ? hits : hits.filter(hit => hit.via === filter);
export function SearchMatchFilter({ hits, value, onChange, busy = false }: { hits: SearchHit[]; value: MatchFilter; busy?: boolean; onChange: (value: MatchFilter) => void }) {
  return <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
    <label>Match type <select aria-label="Filter search matches" value={value} className="rounded border border-border bg-background p-1" onChange={event => onChange(event.target.value as MatchFilter)}>
      <option value="all">All matches</option><option value="name">Best match: file name</option><option value="content">Best match: contents</option><option value="metadata">Best match: descriptions and labels</option>
    </select></label>
    <p role="status" className="text-xs text-muted-foreground">{busy ? 'Loading matches…' : `Showing ${filterMatches(hits, value).length} of ${hits.length} returned matches.`} The server filters by strongest match before returning up to 50 files. A file matching its name and contents is classified by name.</p>
  </div>;
}
