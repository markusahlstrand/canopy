import { Button } from '@canopy/ui';
const countLabel = (count: number, singular: string) => `${count} ${singular}${count === 1 ? '' : 's'}`;
export function SelectionSummary({ items, selection, onClear }: {
  items: { id: string; isFolder: boolean }[]; selection: ReadonlySet<string>; onClear: () => void;
}) {
  const selected = new Map(items.filter(item => selection.has(item.id)).map(item => [item.id, item]));
  const folders = [...selected.values()].filter(item => item.isFolder).length;
  const files = selected.size - folders, absent = selection.size - selected.size;
  return <><p role="status" aria-label="Selection status" className="sr-only">{selected.size ? `${selected.size} selected` : 'Selection cleared'}</p>
    {selection.size ? <section aria-label="Selection" className="mb-3 flex flex-wrap items-center gap-2 rounded border border-border p-2 text-sm">
    <p>{countLabel(selected.size, 'item')} selected: {countLabel(files, 'file')}, {countLabel(folders, 'folder')} on this loaded page.
      {absent ? ` ${countLabel(absent, 'earlier selection')} ${absent === 1 ? 'is' : 'are'} not shown here.` : ''}</p>
    <Button variant="ghost" size="sm" onClick={onClear}>Clear selection</Button>
  </section> : null}</>;
}
