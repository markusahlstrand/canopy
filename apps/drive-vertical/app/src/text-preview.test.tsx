import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TextPreview } from './text-preview';
import { PreviewPanel } from './preview';
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.removeItem('canopy.drive.text-wrap'); vi.unstubAllGlobals(); });
it('toggles layout without altering or parsing the displayed text', () => {
  const text = '<script>alert(1)</script>\n  indented line';
  function Harness() { const [wrap, setWrap] = useState(true); return <TextPreview text={text} wrap={wrap} onWrapChange={setWrap} />; }
  const { container } = render(<Harness />);
  const pre = container.querySelector('pre')!;
  const toggle = screen.getByRole('button', { name: 'Wrap lines' });
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  expect(pre.className).toContain('overflow-wrap:anywhere');
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  expect(pre.className).toContain('whitespace-pre');
  expect(pre.className).not.toContain('pre-wrap');
  expect(pre.textContent).toBe(text);
  expect(container.querySelector('script')).toBeNull();
  fireEvent.click(toggle);
  expect(pre.textContent).toBe(text);
});
it('offers wrapping in the permission-checked text preview without refetching bytes', async () => {
  const fetch = vi.fn(async (url: string) => new Response(url.includes('/content') ? 'original\n  layout' : JSON.stringify({ file: { id: 'a', name: 'notes.txt' }, version: { id: 'v1', source: 'blob', mime: 'text/plain' }, canWrite: false })));
  vi.stubGlobal('fetch', fetch);
  render(<PreviewPanel fileId="a" onClose={() => {}} onError={() => {}} />);
  const toggle = await screen.findByRole('button', { name: 'Wrap lines' });
  const requests = fetch.mock.calls.length;
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  expect(fetch).toHaveBeenCalledTimes(requests);
  expect(screen.queryByRole('button', { name: 'Edit text' })).toBeNull();
});

it('retains the wrap choice through tabs, edit/cancel, saves and switching files in the open panel', async () => {
  let saved = false;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') { saved = true; return new Response(JSON.stringify({ id: 'a' }), { status: 201 }); }
    if (url.includes('/content')) return new Response(saved ? 'saved text' : 'original text');
    if (url.endsWith('/details')) return new Response(JSON.stringify({ fileId: 'a', description: '', labels: [], revision: 0, canWrite: true }));
    return new Response(JSON.stringify({ file: { id: 'a', name: 'notes.txt' }, version: { id: saved ? 'v2' : 'v1', source: 'blob', mime: 'text/plain' }, canWrite: true }));
  });
  const props = { onClose: () => {}, onError: () => {} };
  const view = render(<PreviewPanel {...props} fileId="a" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Wrap lines' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit text' }));
  expect(screen.getByRole('textbox', { name: 'File text' }).getAttribute('wrap')).toBe('off');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }));
  expect(screen.getByRole('button', { name: 'Wrap lines' }).getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(screen.getByRole('button', { name: 'Wrap lines' }).getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: 'Edit text' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'File text' }), { target: { value: 'saved text' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save text' }));
  expect((await screen.findByRole('button', { name: 'Wrap lines' })).getAttribute('aria-pressed')).toBe('false');
  view.rerender(<PreviewPanel {...props} fileId="b" />);
  expect((await screen.findByRole('button', { name: 'Wrap lines' })).getAttribute('aria-pressed')).toBe('false');
});

it('applies another tab’s wrap choice to an open editor without losing the draft or echoing storage', async () => {
  vi.stubGlobal('fetch', async (url: string) => new Response(url.includes('/content') ? 'original' : JSON.stringify({ file: { id: 'a', name: 'notes.txt' }, version: { id: 'v1', source: 'blob', mime: 'text/plain' }, canWrite: true })));
  render(<PreviewPanel fileId="a" onClose={() => {}} onError={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit text' }));
  const editor = screen.getByRole('textbox', { name: 'File text' }) as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: 'unsaved draft' } });
  localStorage.setItem('canopy.drive.text-wrap', JSON.stringify({ version: 1, wrap: false }));
  const write = vi.spyOn(Storage.prototype, 'setItem');
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'canopy.drive.text-wrap', storageArea: localStorage })));
  expect(screen.getByRole('textbox', { name: 'File text' })).toBe(editor);
  expect(editor.getAttribute('wrap')).toBe('off'); expect(editor.value).toBe('unsaved draft'); expect(write).not.toHaveBeenCalled();
});
