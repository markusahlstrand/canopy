import { useMemo } from 'react';
import { lineDiff } from './line-diff';
export function LineDiffView({ before, after }: { before: string; after: string }) {
  const diff = useMemo(() => lineDiff(before, after), [before, after]);
  return <section aria-label="Text changes" className="space-y-1">
    <p className="text-xs text-muted-foreground">− Removed from selected version · + Added in current version. Unchanged leading/trailing lines are omitted.{diff.limited ? ' Alignment or display limit reached: showing a bounded change block. Use the full text below or download to compare all lines.' : ''}</p>
    <div className="max-h-80 overflow-auto"><table className="w-full text-xs"><thead><tr><th>Selected line</th><th>Current line</th><th>Change</th></tr></thead>
      <tbody>{diff.rows.map((row, i) => <tr key={i} className={row.kind === 'removed' ? 'bg-red-500/10' : row.kind === 'added' ? 'bg-green-500/10' : ''}><td className="px-2 align-top">{row.oldLine ?? '—'}</td><td className="px-2 align-top">{row.newLine ?? '—'}</td><td className="whitespace-pre-wrap break-words px-2">{`${row.kind === 'removed' ? '−' : row.kind === 'added' ? '+' : ' '} ${row.text}`}</td></tr>)}</tbody>
    </table></div>
  </section>;
}
