import { useMemo, useState } from 'react';
import { Badge, Button, Icon, Input } from '@canopy/ui';
import { ApiError, fileDetails, updateFileDetails } from './api';
import { FileIcon } from './file-icon';
import type { SortKey } from './file-table';
import type { FileItem } from './items';

export type AllFilesRow = FileItem & { category: string; labels: string[] };

/** A file's tags: each folder on its path, then its labels, once each. */
export const fileTags = (file: Pick<AllFilesRow, 'category' | 'labels'>) =>
  [...new Set([...file.category.split('/').filter(Boolean), ...file.labels])];

const MAX_LABELS = 20, MAX_LABEL_LENGTH = 100;

const headerArrow = (active: boolean, dir: 'asc' | 'desc') => active ? <Icon name="chevron-down" className={dir === 'asc' ? 'size-3 rotate-180' : 'size-3'} /> : null;

/**
 * Every file at or below a folder, flat, with the folders it sits in as tags beside its labels:
 * the view for looking across a space's categories rather than walking them. Picking tags keeps
 * the files that carry all of them. A document filed in two categories is one row per category,
 * as it is in the folders.
 */
export function AllFilesTable({ files, below, sort, onSort, onOpen, loading, more = false, onLabelsChanged }: {
  files: AllFilesRow[];
  /** The folder this view is limited to; null at the top of the space. */
  below: string | null;
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onSort: (key: SortKey) => void;
  onOpen: (id: string) => void;
  loading: boolean;
  /** More pages exist, so tags and counts only cover the files loaded so far. */
  more?: boolean;
  /** Labels were saved for a file. Without it, tags cannot be added or removed here. */
  onLabelsChanged?: (fileId: string, labels: string[]) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  // One row's tag edit at a time: the open input, the save in flight, and what went wrong.
  const [adding, setAdding] = useState<{ id: string; draft: string } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ id: string; message: string } | null>(null);
  const tagged = useMemo(() => files.map(file => ({ file, tags: fileTags(file) })), [files]);
  // Most-used first, so the tags that split the space are the first ones offered.
  const counts = useMemo(() => {
    const count = new Map<string, number>();
    for (const { tags } of tagged) for (const tag of tags) count.set(tag, (count.get(tag) ?? 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [tagged]);
  // A picked tag no loaded file carries any more (a re-sort or reload changed `files`) has no chip
  // to unpick it by, and would hide every row: only the tags still on offer filter.
  const active = useMemo(() => picked.filter(tag => counts.some(([t]) => t === tag)), [picked, counts]);
  const toggle = (tag: string) => setPicked(now => now.includes(tag) ? now.filter(t => t !== tag) : [...now, tag]);
  const shown = active.length ? tagged.filter(({ tags }) => active.every(tag => tags.includes(tag))) : tagged;

  /** Change a file's labels against its latest details, so labels saved elsewhere are kept. */
  const changeLabels = async (file: AllFilesRow, edit: (labels: string[]) => string[]) => {
    if (!onLabelsChanged || saving) return;
    setSaving(file.id);
    setProblem(null);
    try {
      const details = await fileDetails(file.id);
      if (!details.canWrite) { setProblem({ id: file.id, message: `You can't change the tags on ${file.name}.` }); return; }
      const labels = edit(details.labels);
      if (labels.length > MAX_LABELS) { setProblem({ id: file.id, message: `A file takes at most ${MAX_LABELS} labels.` }); return; }
      const saved = await updateFileDetails(file.id, details.description, labels, details.revision);
      onLabelsChanged(file.id, saved.labels);
      setAdding(null);
    } catch (e: unknown) {
      setProblem({ id: file.id, message: e instanceof ApiError && e.status === 409
        ? `${file.name} changed elsewhere. Reload and try again.`
        : e instanceof Error ? e.message || 'Could not save the tag.' : String(e) });
    } finally {
      setSaving(null);
    }
  };
  const addLabel = (file: AllFilesRow, draft: string) => {
    const label = draft.trim();
    if (!label) { setAdding(null); return; }
    if (label.length > MAX_LABEL_LENGTH) { setProblem({ id: file.id, message: `Keep a tag to ${MAX_LABEL_LENGTH} characters.` }); return; }
    void changeLabels(file, labels => labels.includes(label) ? labels : [...labels, label]);
  };

  if (!files.length) {
    return <p role="status" className="rounded-lg border px-4 py-10 text-center text-sm text-muted-foreground">
      {loading ? 'Loading files…' : below ? `No files in ${below} or below it.` : 'No files in this space yet.'}
    </p>;
  }
  const chip = (tag: string, count?: number) => {
    const on = active.includes(tag);
    // A row's chips repeat the bar's names; say what they do so a screen reader hears more than "Fiscal".
    return <button key={tag} type="button" aria-pressed={on} aria-label={count === undefined ? `Filter by tag ${tag}` : undefined} onClick={() => toggle(tag)}
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
      {active.length ? <Button type="button" variant="ghost" size="sm" onClick={() => setPicked([])}>Clear tags</Button> : null}
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
            const busy = saving === file.id;
            const removable = (tag: string) => onLabelsChanged && file.labels.includes(tag)
              ? <span key={tag} className="inline-flex items-center">
                {chip(tag)}
                <button type="button" aria-label={`Remove tag ${tag} from ${file.name}`} disabled={busy}
                  onClick={() => void changeLabels(file, labels => labels.filter(label => label !== tag))}
                  className="rounded-md p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
                  <Icon name="x" className="size-3" />
                </button>
              </span>
              : chip(tag);
            const chips = <span className="flex flex-wrap items-center gap-1">
              {tags.length ? tags.map(removable) : <span className="text-xs text-muted-foreground">No tags</span>}
              {onLabelsChanged ? <Button type="button" variant="ghost" size="icon-xs" aria-label={`Add tag to ${file.name}`} title="Add tag" disabled={busy}
                onClick={() => { setProblem(null); setAdding({ id: file.id, draft: '' }); }}>
                <Icon name="plus" />
              </Button> : null}
            </span>;
            return <tr key={file.id} className="border-b last:border-0 hover:bg-accent/50">
              <td className="px-3 py-1.5">
                <button type="button" className="flex w-full min-w-0 items-center gap-2 text-left" onClick={() => onOpen(file.id)}>
                  <FileIcon kind={file.kind} />
                  <span className="block min-w-0 truncate font-medium">{file.name}</span>
                </button>
                {/* Below `md` the tags column is gone; the tags go under the name instead. */}
                <div className="mt-1 md:hidden">{chips}</div>
                {/* Once per row, not in both layouts' chips, so there is one input to type in. */}
                {adding?.id === file.id ? <form className="mt-1 flex items-center gap-1" onSubmit={(event) => { event.preventDefault(); addLabel(file, adding.draft); }}>
                  <Input autoFocus aria-label={`New tag for ${file.name}`} className="h-7 text-xs" maxLength={MAX_LABEL_LENGTH} value={adding.draft} disabled={busy}
                    onChange={(event) => setAdding({ id: file.id, draft: event.target.value })}
                    onKeyDown={(event) => { if (event.key === 'Escape') setAdding(null); }} />
                  <Button type="submit" size="xs" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
                  <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => setAdding(null)}>Cancel</Button>
                </form> : null}
                {problem?.id === file.id ? <p role="alert" className="mt-1 text-xs text-destructive">{problem.message}</p> : null}
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
