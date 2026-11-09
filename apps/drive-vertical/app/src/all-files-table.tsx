import { Badge, Icon } from '@canopy/ui';
import { FileIcon } from './file-icon';
import type { SortKey } from './file-table';
import type { FileItem } from './items';

export type AllFilesRow = FileItem & { category: string; labels: string[] };

const headerArrow = (active: boolean, dir: 'asc' | 'desc') => active ? <Icon name="chevron-down" className={dir === 'asc' ? 'size-3 rotate-180' : 'size-3'} /> : null;

/**
 * Every file at or below a folder, flat, with where each one sits and its labels: the view for
 * looking across a space's categories rather than walking them. A document filed in two
 * categories is one row per category, as it is in the folders.
 */
export function AllFilesTable({ files, below, sort, onSort, onOpen, loading }: {
  files: AllFilesRow[];
  /** The folder this view is limited to; null at the top of the space. */
  below: string | null;
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onSort: (key: SortKey) => void;
  onOpen: (id: string) => void;
  loading: boolean;
}) {
  if (!files.length) {
    return <p role="status" className="rounded-lg border px-4 py-10 text-center text-sm text-muted-foreground">
      {loading ? 'Loading files…' : below ? `No files in ${below} or below it.` : 'No files in this space yet.'}
    </p>;
  }
  const heading = (key: SortKey, label: string, className = '') => (
    <th aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={`px-3 py-2 text-left font-medium ${className}`}>
      <button type="button" className="inline-flex items-center gap-1" onClick={() => onSort(key)}>{label}{headerArrow(sort.key === key, sort.dir)}</button>
    </th>
  );
  return <div className="overflow-hidden rounded-lg border">
    <table className="w-full table-fixed text-sm">
      <thead className="border-b text-xs text-muted-foreground">
        <tr>
          {heading('name', 'Name')}
          <th className="hidden w-1/4 px-3 py-2 text-left font-medium md:table-cell">Category</th>
          <th className="hidden w-1/5 px-3 py-2 text-left font-medium lg:table-cell">Labels</th>
          {heading('modified', 'Modified', 'hidden w-[124px] md:table-cell')}
        </tr>
      </thead>
      <tbody>
        {files.map((file) => <tr key={file.id} className="border-b last:border-0 hover:bg-accent/50">
          <td className="px-3 py-1.5">
            <button type="button" className="flex w-full min-w-0 items-center gap-2 text-left" onClick={() => onOpen(file.id)}>
              <FileIcon kind={file.kind} />
              <span className="min-w-0">
                <span className="block truncate font-medium">{file.name}</span>
                {/* Below `md` the category column is gone; this is the only place left to say it. */}
                <span className="block truncate text-xs text-muted-foreground md:hidden">{file.category || 'Top level'}</span>
              </span>
            </button>
          </td>
          <td className="hidden truncate px-3 py-1.5 text-muted-foreground md:table-cell" title={file.category}>{file.category || 'Top level'}</td>
          <td className="hidden px-3 py-1.5 lg:table-cell">
            <span className="flex flex-wrap gap-1">{file.labels.map((label) => <Badge key={label} variant="secondary">{label}</Badge>)}</span>
          </td>
          <td className="hidden px-3 py-1.5 font-mono text-[12.5px] text-muted-foreground md:table-cell">{file.modified}</td>
        </tr>)}
      </tbody>
    </table>
  </div>;
}
