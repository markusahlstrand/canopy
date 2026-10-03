import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CsvTable, parseCsvPreview } from './csv-table';
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
  const fetcher = vi.fn(async (url: string) => new Response(url.includes('/content') ? 'a,b\n1,2' : JSON.stringify({ file: { id: 'f', name: 'sheet.csv' }, version: { id: 'v', source: 'blob', mime: 'text/csv' }, canWrite: false })));
  vi.stubGlobal('fetch', fetcher); render(<PreviewPanel fileId="f" onClose={() => {}} onError={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Table' }));
  expect(screen.getByRole('cell', { name: '2' })).toBeTruthy(); expect(fetcher).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'Preview' })); expect(screen.getByRole('searchbox')).toBeTruthy();
});

it('reports clipped columns and hints at alternate delimiters', () => {
  const view = render(<CsvTable text={Array(60).fill('x').join(',')} />);
  expect(screen.getAllByRole('columnheader')).toHaveLength(50);
  expect(screen.getByRole('status').textContent).toContain('Showing 50 of 60 columns');
  view.rerender(<CsvTable text={'a;b;c\n1;2;3'} />);
  expect(screen.getByRole('status').textContent).toContain('different delimiter');
});
