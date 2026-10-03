import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CsvTable, detectCsvDelimiter, parseCsvPreview } from './csv-table';
import { PreviewPanel } from './preview';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('parses escaped fields, newlines, BOM, CRLF and empty trailing cells', () => {
  expect(parseCsvPreview('\ufeffa,"b,c","say ""hi"""\r\n"two\nlines",,\r\n').rows).toEqual([['a', 'b,c', 'say "hi"'], ['two\nlines', '', '']]);
  expect(() => parseCsvPreview('"unfinished')).toThrow('unclosed');
  expect(() => parseCsvPreview('a"b')).toThrow('invalid quoting');
  expect(() => parseCsvPreview('"a"x')).toThrow('invalid quoting');
});
it('bounds rendered rows/columns and renders cells as plain text', () => {
  render(<CsvTable text={'<script>x</script>,=CMD()\n'.repeat(201)} />);
  expect(screen.getByRole('status').textContent).toContain('first 200 of 201');
  expect(screen.getAllByRole('row')).toHaveLength(201); expect(document.querySelector('script')).toBeNull();
  const wide = parseCsvPreview(Array(60).fill('x').join(','));
  expect(wide.rows[0]).toHaveLength(50); expect(wide.totalColumns).toBe(60);
  expect(parseCsvPreview('x\n'.repeat(300) + Array(60).fill('x').join(',')).totalColumns).toBe(60);
});
it('offers a CSV table alongside the existing text preview without another read', async () => {
  const fetcher = vi.fn(async (url: string) => new Response(url.endsWith('/plugins') ? JSON.stringify({plugins: []}) : url.includes('/content') ? 'a,b\n1,2' : JSON.stringify({ file: { id: 'f', name: 'sheet.csv' }, version: { id: 'v', source: 'blob', mime: 'text/csv' }, canWrite: false })));
  vi.stubGlobal('fetch', fetcher); render(<PreviewPanel fileId="f" onClose={() => {}} onError={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Table' }));
  expect(screen.getByRole('cell', { name: '2' })).toBeTruthy(); expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/plugins', '/api/files/f', '/api/files/f/versions/v/content']);
  fireEvent.click(screen.getByRole('button', { name: 'Preview' })); expect(screen.getByRole('searchbox')).toBeTruthy();
});

it('reports clipped columns and hints at alternate delimiters', () => {
  const view = render(<CsvTable text={Array(60).fill('x').join(',')} />);
  expect(screen.getAllByRole('columnheader')).toHaveLength(50);
  expect(screen.getByRole('status').textContent).toContain('Showing 50 of 60 columns');
  view.rerender(<CsvTable text={'a;b;c\n1;2;3'} />);
  expect(screen.getByRole('combobox').getAttribute('value') ?? (screen.getByRole('combobox') as HTMLSelectElement).value).toBe(';');
});

it('lets readers select semicolon/tab delimiters even after a comma parse error', () => {
  const view = render(<CsvTable text={'a;"b,c";"two\nlines"\r\n1;2;3'} />);
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: ',' } });
  expect(screen.getByRole('alert').textContent).toContain('Try another separator');
  fireEvent.change(screen.getByRole('combobox', { name: 'CSV separator' }), { target: { value: ';' } });
  expect(screen.queryByRole('alert')).toBeNull(); expect(screen.getByRole('cell', { name: 'b,c' })).toBeTruthy();
  expect(screen.getAllByRole('columnheader')).toHaveLength(3);
  view.rerender(<CsvTable text={'a\tb\tc\n1\t2\t3'} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'CSV separator' }), { target: { value: '\t' } });
  expect(screen.getByRole('cell', { name: '3' })).toBeTruthy();
  expect(parseCsvPreview(Array(60).fill('x').join(';'), ';').rows[0]).toHaveLength(50);
});

it.each(['Name;Price\nApple;1,50\nPear;2,25', '"Name";"Price"\n"Apple";"1,50"'])('detects European CSV exports without splitting decimal commas', text => {
  render(<CsvTable text={text} />);
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(';');
  expect(screen.getByRole('cell', { name: '1,50' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});
it('ignores quoted separators when sniffing and parses quoted selected delimiters', () => {
  expect(detectCsvDelimiter('"a;b",c\n1;2;3')).toBe(',');
  expect(detectCsvDelimiter('a,b;c')).toBe(',');
  expect(parseCsvPreview('"x;y";z', ';').rows).toEqual([['x;y', 'z']]);
  expect(parseCsvPreview('"x\ty"\tz', '\t').rows).toEqual([['x\ty', 'z']]);
});
it('offers TSV tables and retains a chosen separator across Preview/Table switches', async () => {
  const fetcher = vi.fn(async (url: string) => new Response(url.includes('/content') ? 'a\tb\n1\t2' : JSON.stringify({ file: { id: 'f', name: 'sheet.tsv' }, version: { id: 'v', source: 'blob', mime: 'text/tab-separated-values' }, canWrite: false })));
  vi.stubGlobal('fetch', fetcher); render(<PreviewPanel fileId="f" onClose={() => {}} onError={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Table' }));
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('\t');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: ';' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  const reads = fetcher.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Table' }));
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(';');
  expect(fetcher).toHaveBeenCalledTimes(reads);
});
