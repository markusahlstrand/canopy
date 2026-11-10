import { useMemo, useState } from 'react';
import { Badge, Button, Icon } from '@canopy/ui';
import { FileIcon } from './file-icon';
import type { SortKey } from './file-table';
import type { FileItem } from './items';

export type AllFilesRow = FileItem & { category: string; labels: string[] };

/** A file's tags: each folder on its path, then its labels, once each. */
export const fileTags = (file: Pick<AllFilesRow, 'category' | 'labels'>) =>
  [...new Set([...file.category.split('/').filter(Boolean), ...file.labels])];

const headerArrow = (active: boolean, dir: 'asc' | 'desc') => active ? <Icon name="chevron-down" className={dir === 'asc' ? 'size-3 rotate-180' : 'size-3'} /> : null;

/**
 * Every file at or below a folder, flat, with the folders it sits in as tags beside its labels:
 * the view for looking across a space's categories rather than walking them. Picking tags keeps
 * the files that carry all of them. A document filed in two categories is one row per category,
 * as it is in the folders.
 */
export function AllFilesTable({ files, below, sort, onSort, onOpen, loading, more = false }: {
  files: AllFilesRow[];
  /** The folder this view is limited to; null at the top of the space. */
  below: string | null;
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onSort: (key: SortKey) => void;
  onOpen: (id: string) => void;
  loading: boolean;
  /** More pages exist, so tags and counts only cover the files loaded so far. */
  more?: boolean;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const tagged = useMemo(() => files.map(file => ({ file, tags: fileTags(file) })), [files]);
  // Most-used first, so the tags that split the space are the first ones offered.
  const counts = useMemo(() => {
    const count = new Map<string, number>();
    for (const { tags } of tagged) for (const tag of tags) count.set(tag, (count.get(tag) ?? 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [tagged]);
  const toggle = (tag: string) => setPicked(now => now.includes(tag) ? now.filter(t => t !== tag) : [...now, tag]);
  const shown = picked.length ? tagged.filter(({ tags }) => picked.every(tag => tags.includes(tag))) : tagged;

  if (!files.length) {
    return <p role="status" className="rounded-lg border px-4 py-10 text-center text-sm text-muted-foreground">
      {loading ? 'Loading files…' : below ? `No files in ${below} or below it.` : 'No files in this space yet.'}
    </p>;
  }
  const chip = (tag: string, count?: number) => {
    const on = picked.includes(tag);
    return <button key={tag} type="button" aria-pressed={on} onClick={() => toggle(tag)}
      className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Badge variant={on ? 'default' : 'secondary'}>{tag}{count === undefined ? null : <span className="ml-1 opacity-60">{count}</span>}</Badge>
    </button>;
  };
  const heading = (key: SortKey, label: string, className = '') => (
    <th aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={`px-3 py-2 text-left font-medium ${className}`}>
      <button type="button" className="inline-flex items-center gap-1" onClick={() => onSort(key)}>{label}{headerArrow(sort.key === key, sort.dir)}</button>
    </th>
  );
  return <div className="space-y-3">
    <div role="group" aria-label="Filter by tag" className="flex flex-wrap items-center gap-1.5">
      {counts.map(([tag, count]) => chip(tag, count))}
      {picked.length ? <Button type="button" variant="ghost" size="sm" onClick={() => setPicked([])}>Clear tags</Button> : null}
      {more ? <span className="text-xs text-muted-foreground">Tags cover the files loaded so far.</span> : null}
    </div>
    {shown.length ? <div className="overflow-hidden rounded-lg border">
      <table className="w-full table-fixed text-sm">
        <thead className="border-b text-xs text-muted-foreground">
          <tr>
            {heading('name', 'Name')}
            <th className="hidden w-2/5 px-3 py-2 text-left font-medium md:table-cell">Tags</th>
            {heading('modified', 'Modified', 'hidden w-[124px] md:table-cell')}
          </tr>
        </thead>
        <tbody>
          {shown.map(({ file, tags }) => {
            const chips = tags.length ? <span className="flex flex-wrap gap-1">{tags.map(tag => chip(tag))}</span>
              : <span className="text-xs text-muted-foreground">No tags</span>;
            return <tr key={file.id} className="border-b last:border-0 hover:bg-accent/50">
              <td className="px-3 py-1.5">
                <button type="button" className="flex w-full min-w-0 items-center gap-2 text-left" onClick={() => onOpen(file.id)}>
                  <FileIcon kind={file.kind} />
                  <span className="block min-w-0 truncate font-medium">{file.name}</span>
                </button>
                {/* Below `md` the tags column is gone; the tags go under the name instead. */}
                <div className="mt-1 md:hidden">{chips}</div>
              </td>
              <td className="hidden px-3 py-1.5 md:table-cell">{chips}</td>
              <td className="hidden px-3 py-1.5 font-mono text-[12.5px] text-muted-foreground md:table-cell">{file.modified}</td>
            </tr>;
          })}
        </tbody>
      </table>
    </div> : <p role="status" className="rounded-lg border px-4 py-10 text-center text-sm text-muted-foreground">
      {more ? 'None of the files loaded so far has all of these tags. Load more to look further.' : 'No file has all of these tags.'}
    </p>}
  </div>;
}
