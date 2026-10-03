import { useMemo } from 'react';

const ROW_LIMIT = 200, COLUMN_LIMIT = 50;
/** Comma-delimited CSV, with escaped quotes and embedded newlines. No header assumption. */
export function parseCsvPreview(text: string) {
  if (text.length > 512 * 1024) throw new Error('CSV is too large for a table preview.');
  const rows: string[][] = []; let row: string[] = [], field = '', count = 0, columns = 0;
  let state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  const cell = () => { row.push(field); field = ''; state = 'start'; if (row.length > COLUMN_LIMIT) throw new Error('Table preview supports up to 50 columns.'); };
  const record = () => { cell(); columns = Math.max(columns, row.length); count++; if (rows.length < ROW_LIMIT) rows.push(row); row = []; };
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const char = text[i]!;
    if (state === 'quoted') {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') state = 'closed';
      else field += char;
    } else if (char === ',') cell();
    else if (char === '\n' || char === '\r') { record(); if (char === '\r' && text[i + 1] === '\n') i++; }
    else if (char === '"' && state === 'start') state = 'quoted';
    else {
      if (state === 'closed' || char === '"') throw new Error('CSV contains invalid quoting. Use the text preview instead.');
      field += char; state = 'plain';
    }
  }
  if (state === 'quoted') throw new Error('CSV contains an unclosed quoted field. Use the text preview instead.');
  if (field || row.length || state !== 'start') record();
  return { rows, columns, total: count };
}
export function CsvTable({ text }: { text: string }) {
  const result = useMemo(() => { try { return { data: parseCsvPreview(text) }; } catch (error) { return { error: (error as Error).message }; } }, [text]);
  if (!result.data) return <p role="alert">{result.error}</p>;
  const { rows, columns, total } = result.data;
  return <section aria-label="CSV table" className="space-y-2">
    <p role="status" className="text-xs text-muted-foreground">{total > rows.length ? `Showing the first ${rows.length} of ${total} rows.` : `${total} rows.`} All rows are data; column labels are generated.</p>
    <div className="overflow-auto"><table className="text-sm"><thead><tr>{Array.from({ length: columns }, (_, i) => <th key={i} className="border p-2">Column {i + 1}</th>)}</tr></thead>
      <tbody>{rows.map((row, i) => <tr key={i}>{Array.from({ length: columns }, (_, j) => <td key={j} className="max-w-xs whitespace-pre-wrap break-words border p-2">{row[j] ?? ''}</td>)}</tr>)}</tbody></table></div>
  </section>;
}
