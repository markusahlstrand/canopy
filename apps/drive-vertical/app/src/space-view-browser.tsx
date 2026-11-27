import { useMemo, useState } from 'react';
import { Badge, Button, Icon } from '@canopy/ui';
import type { SpaceView } from '../../src/space-settings';
import { AllFilesTable, type AllFilesRow } from './all-files-table';
import type { SortKey } from './file-table';
import { pathLabels, suggestedPlacement, viewLevel, VIEW_KEY_LABEL, type ViewFile } from './space-views';

const UNCONFIRMED = 'Document AI chose this category and nobody has confirmed it yet.';
/**
 * Rows a leaf mounts at a time. A view reads the whole space without anyone asking, so one group
 * can hold thousands of files; the table mounts these and offers the rest a page at a time.
 */
export const LEAF_PAGE = 200;

/**
 * One saved view of the space, browsed like folders: the groups at the current level, and the
 * documents once every level is chosen. The groups are worked out from the documents' metadata
 * on each read, so a new document is in its place as soon as it has that metadata. Opening a
 * document is the same preview as from its folder; nothing here moves it.
 */
export function SpaceViewBrowser({ view, files, categories, path, onPath, toRow, onOpen, loading, more, sort, onSort, onLabelsChanged }: {
  view: SpaceView;
  files: ViewFile[];
  categories: { id: string; name: string }[];
  /** The chosen value at each level so far. */
  path: string[];
  onPath: (path: string[]) => void;
  /** A file as the table shows it, sorted as the screen sorts. */
  toRow: (files: ViewFile[]) => AllFilesRow[];
  onOpen: (id: string) => void;
  loading: boolean;
  /** The space has more files than were read, so counts cover only the first ones. */
  more: boolean;
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onSort: (key: SortKey) => void;
  onLabelsChanged?: (fileId: string, labels: string[]) => void;
}) {
  const names = useMemo(() => new Map(categories.map(c => [c.id, c.name])), [categories]);
  // A path from before the view changed, or a value no document has any more, opens the top.
  const level = useMemo(() => viewLevel(files, view.groupBy, path.slice(0, view.groupBy.length), names), [files, view.groupBy, path, names]);
  const labels = useMemo(() => pathLabels(files, view.groupBy, path, names), [files, view.groupBy, path, names]);
  const marked = useMemo(() => new Set(files.filter(file => suggestedPlacement(file, view.groupBy)).map(file => file.id)), [files, view.groupBy]);

  return <div className="space-y-3">
    {/* At the top, the heading and the topbar already name the view; a trail starts one level down. */}
    {path.length ? <nav aria-label={`Path in ${view.name}`} className="flex flex-wrap items-center gap-1 text-sm">
      <button type="button" className="rounded px-1 font-medium hover:bg-accent" onClick={() => onPath([])} aria-current={path.length === 0 ? 'page' : undefined}>{view.name}</button>
      {labels.map((label, depth) => <span key={depth} className="flex items-center gap-1">
        <Icon name="chevron-right" className="size-3.5 text-muted-foreground" />
        <button type="button" className="rounded px-1 hover:bg-accent" aria-current={depth === path.length - 1 ? 'page' : undefined} onClick={() => onPath(path.slice(0, depth + 1))}>{label}</button>
      </span>)}
    </nav> : null}
    <p className="text-xs text-muted-foreground">
      Grouped by {view.groupBy.map(key => VIEW_KEY_LABEL[key].toLowerCase()).join(', then ')}. Documents stay in their folders; this only shows them another way.
      {more ? ' This space has more documents than were read, so the groups cover the first ones.' : ''}
    </p>
    {level.kind === 'groups' ? (
      level.groups.length ? <ul aria-label={VIEW_KEY_LABEL[level.key]} className="overflow-hidden rounded-lg border">
        {level.groups.map(group => <li key={group.value} className="border-b last:border-0">
          <button type="button" className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent/50" onClick={() => onPath([...path, group.value])}>
            <Icon name="folder" className={`size-4 shrink-0 ${group.missing ? 'text-muted-foreground' : 'text-primary'}`} />
            <span className={`min-w-0 flex-1 truncate ${group.missing ? 'italic text-muted-foreground' : 'font-medium'}`}>{group.label}</span>
            {group.suggested ? <span title={`Document AI chose the category of ${group.suggested} of these, and nobody has confirmed it yet.`}>
              <Badge variant="outline" className="gap-1 text-[11px] font-normal"><Icon name="sparkles" className="size-3" />{group.suggested} by AI</Badge>
            </span> : null}
            <span className="w-10 shrink-0 text-right font-mono text-xs text-muted-foreground">{group.count}</span>
            <Icon name="chevron-right" className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </li>)}
      </ul> : <p role="status" className="rounded-lg border px-4 py-10 text-center text-sm text-muted-foreground">
        {loading ? 'Loading files…' : 'No documents here.'}
      </p>
    ) : <ViewLeaf
      key={path.join('\u0000')}
      rows={toRow(level.files)}
      sort={sort}
      onSort={onSort}
      onOpen={onOpen}
      loading={loading}
      mark={file => marked.has(file.id) ? UNCONFIRMED : null}
      onLabelsChanged={onLabelsChanged}
    />}
  </div>;
}

/** The files at the end of a path, mounted a page at a time. */
function ViewLeaf({ rows, sort, onSort, onOpen, loading, mark, onLabelsChanged }: {
  rows: AllFilesRow[];
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onSort: (key: SortKey) => void;
  onOpen: (id: string) => void;
  loading: boolean;
  mark: (file: AllFilesRow) => string | null;
  onLabelsChanged?: (fileId: string, labels: string[]) => void;
}) {
  const [limit, setLimit] = useState(LEAF_PAGE);
  const shown = rows.length > limit ? rows.slice(0, limit) : rows;
  const rest = rows.length - shown.length;
  return <div className="space-y-3">
    <AllFilesTable files={shown} below={null} empty="No documents here." sort={sort} onSort={onSort} onOpen={onOpen}
      loading={loading} more={rest > 0} mark={mark} onLabelsChanged={onLabelsChanged} />
    {rest > 0 ? <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <Button type="button" variant="outline" size="sm" onClick={() => setLimit(n => n + LEAF_PAGE)}>Show {Math.min(rest, LEAF_PAGE)} more</Button>
      Showing {shown.length} of {rows.length}.
    </div> : null}
  </div>;
}
