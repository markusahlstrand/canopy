import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { VersionComparison } from './version-comparison';
import { PreviewPanel } from './preview';
import { TEXT_PREVIEW_LIMIT } from './api';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const props = { fileId: 'file', selectedId: 'old', currentId: 'current', onClose: () => {} };
it('compares immutable version bytes as plain text and identifies equal contents', async () => {
  const fetcher = vi.fn(async (_url: string) => new Response('<script>plain text</script>')); vi.stubGlobal('fetch', fetcher);
  const view = render(<VersionComparison {...props} />);
  await screen.findByText('These versions contain the same text (ignoring line endings and a final newline).');
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/files/file/versions/old/content', '/api/files/file/versions/current/content']);
  expect(view.container.querySelector('script')).toBeNull(); expect(view.container.querySelectorAll('pre')[0]!.textContent).toBe('<script>plain text</script>');
});
it('labels partial comparisons instead of claiming full equality', async () => {
  vi.stubGlobal('fetch', async () => new Response('a'.repeat(TEXT_PREVIEW_LIMIT + 1)));
  render(<VersionComparison {...props} />); await screen.findByText(/Showing partial text/);
  expect(screen.queryByText(/same text/)).toBeNull();
});
it('retries failures and retires answers when the comparison changes', async () => {
  let answer!: (response: Response) => void;
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(new Response('head'))
    .mockImplementationOnce(() => new Promise<Response>(resolve => { answer = resolve; })).mockImplementation(async () => new Response('new'));
  vi.stubGlobal('fetch', fetcher); const view = render(<VersionComparison {...props} />); await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Retry comparison' }));
  view.rerender(<VersionComparison {...props} selectedId="other" />);
  await screen.findByText('These versions contain the same text (ignoring line endings and a final newline).');
  await act(async () => answer(new Response('stale')));
  expect(screen.queryByText('stale')).toBeNull();
});
it('offers comparison to readers only for historical managed text versions', async () => {
  const old = { id: 'old', source: 'blob', blob_ref: 'blob', mime: 'text/plain', created_at: '2026-01-01' };
  vi.stubGlobal('fetch', async (url: string) => new Response(url.includes('/content') ? (url.includes('/old/') ? 'old text' : 'current text')
    : JSON.stringify(url.endsWith('/versions') ? [old, { ...old, id: 'external', source: 'external' }, { ...old, id: 'binary', mime: 'image/png' }]
      : { file: { id: 'file', name: 'notes.txt' }, version: { ...old, id: 'current' }, canWrite: false })));
  render(<PreviewPanel fileId="file" onError={() => {}} onClose={() => {}} />); await screen.findByText('current text');
  fireEvent.click(screen.getByRole('button', { name: 'Versions' }));
  const compare = await screen.findByRole('button', { name: /^Compare version/ }); fireEvent.click(compare);
  const comparison = await screen.findByLabelText('Version comparison'); await within(comparison).findByText('old text');
  expect(within(comparison).getByText('current text')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close comparison' })); expect(screen.queryByLabelText('Version comparison')).toBeNull();
});
it('keeps the current-at-open version pinned after restoring a different head', async () => {
  const old = { keep: 0, id: 'old', file_id: 'file', source: 'blob', blob_ref: 'blob', mime: 'text/plain', size: 8, created_at: '2026-01-01T00:00:00Z' };
  let restored = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') restored = true;
    if (url.includes('/content')) return new Response(url.includes('/old/') ? 'old text' : 'current text');
    return new Response(JSON.stringify(url.endsWith('/versions') ? [old] : { file: { id: 'file', name: 'notes.txt' }, version: { ...old, id: restored ? 'restored' : 'current' }, canWrite: true }));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<PreviewPanel fileId="file" onError={() => {}} onClose={() => {}} />); await screen.findByText('current text');
  fireEvent.click(screen.getByRole('button', { name: 'Versions' })); fireEvent.click(await screen.findByRole('button', { name: /^Compare version/ }));
  const comparison = await screen.findByLabelText('Version comparison'); await within(comparison).findByText('old text');
  fireEvent.click(screen.getByRole('button', { name: 'Restore' })); fireEvent.click(screen.getByRole('button', { name: 'Confirm restore' }));
  await act(async () => {});
  expect(restored).toBe(true); expect(screen.getByLabelText('Version comparison')).toBe(comparison); expect(within(comparison).getByText('current text')).toBeTruthy();
  expect(fetcher.mock.calls.some(([url]) => url === '/api/files/file/versions/restored/content')).toBe(false);
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/files/file/versions/current/content')).toHaveLength(2);
});

it('marks line changes and treats non-UTF-8 versions as non-retryable downloads', async () => {
  vi.stubGlobal('fetch', async (url: string) => new Response(url.includes('/old/') ? 'keep\nremoved\nend' : 'keep\nadded\nend'));
  const view = render(<VersionComparison {...props} />);
  expect(await screen.findByRole('cell', { name: '− removed' })).toBeTruthy(); expect(screen.getByRole('cell', { name: '+ added' })).toBeTruthy();
  view.unmount(); vi.stubGlobal('fetch', async () => new Response(new Uint8Array([0xff])));
  render(<VersionComparison {...props} />); await screen.findByText(/not UTF-8 text/);
  expect(screen.queryByRole('button', { name: 'Retry comparison' })).toBeNull(); expect(screen.getByRole('link', { name: 'Download selected version' })).toBeTruthy();
});
