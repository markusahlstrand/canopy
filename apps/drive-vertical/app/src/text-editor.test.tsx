import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TextEditor } from './text-editor';
import { PreviewPanel } from './preview';
import { selectSite } from './api';
afterEach(() => { cleanup(); selectSite(null); vi.unstubAllGlobals(); });
const props = () => ({ fileId: 'file a', versionId: 'version/1', text: 'old', onSaved: vi.fn(async () => {}), onReload: vi.fn(async () => {}), onCancel: vi.fn() });
function edit() { fireEvent.change(screen.getByRole('textbox', { name: 'File text' }), { target: { value: 'new draft' } }); }
describe('conditional text editor', () => {
  it('saves the draft with its immutable version and selected scope', async () => {
    selectSite('family');
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'file a', current_version_id: 'v2' }), { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    const p = props(); render(<TextEditor {...p} />); edit();
    fireEvent.click(screen.getByRole('button', { name: 'Save text' }));
    await waitFor(() => expect(p.onSaved).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith('/api/files/file%20a/content?expectedVersion=version%2F1', expect.objectContaining({ method: 'PUT', body: 'new draft', headers: { 'x-site': 'family', 'content-type': 'text/plain; charset=utf-8' } }));
  });
  it('retains a conflicting draft and confirms before discarding it to reload', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ detail: 'changed' }), { status: 409 }));
    const p = props(); render(<TextEditor {...p} />); edit();
    fireEvent.click(screen.getByRole('button', { name: 'Save text' }));
    await screen.findByRole('alert');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('new draft');
    expect(p.onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
    expect(p.onReload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard edits and reload' }));
    await waitFor(() => expect(p.onReload).toHaveBeenCalledOnce());
  });
  it('retries a refresh failure without posting another version', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'file a' }), { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    const p = props(); p.onSaved.mockRejectedValueOnce(new Error('refresh failed'));
    render(<TextEditor {...p} />); edit(); fireEvent.click(screen.getByRole('button', { name: 'Save text' }));
    await screen.findByText('refresh failed');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh saved text' }));
    await waitFor(() => expect(p.onSaved).toHaveBeenCalledTimes(2));
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('retires a save response when the editor closes', async () => {
    let answer!: (value: Response) => void;
    vi.stubGlobal('fetch', () => new Promise<Response>(resolve => { answer = resolve; }));
    const p = props(); const view = render(<TextEditor {...p} />); edit(); fireEvent.click(screen.getByRole('button', { name: 'Save text' }));
    view.unmount(); answer(new Response('{}', { status: 201 }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(p.onSaved).not.toHaveBeenCalled();
  });
});
describe('preview text editing', () => {
  function preview(canWrite: boolean, body = 'original', invalid = false) {
    let saved = false;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') { saved = true; return new Response(JSON.stringify({ id: 'a', current_version_id: 'v2' }), { status: 201 }); }
      if (url.includes('/content')) return new Response(invalid ? new Uint8Array([255]) : saved ? 'new draft' : body);
      return new Response(JSON.stringify({ file: { id: 'a', name: 'notes.md' }, version: { id: saved ? 'v2' : 'v1', source: 'blob', mime: 'text/markdown' }, canWrite }));
    });
    vi.stubGlobal('fetch', fetch);
    const onChanged = vi.fn(), onError = vi.fn();
    render(<PreviewPanel fileId="a" onClose={() => {}} onError={onError} onChanged={onChanged} />);
    return { fetch, onChanged, onError };
  }
  it('loads immutable bytes and refreshes the preview after saving', async () => {
    const p = preview(true); await screen.findByText('original');
    expect(p.fetch).toHaveBeenCalledWith('/api/files/a/versions/v1/content', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Edit text' })); edit();
    fireEvent.click(screen.getByRole('button', { name: 'Save text' }));
    await screen.findByText('new draft');
    expect(p.onChanged).toHaveBeenCalledOnce();
    expect(screen.queryByRole('textbox')).toBeNull();
    await waitFor(() => expect(p.fetch).toHaveBeenCalledWith('/api/files/a/versions/v2/content', expect.anything()));
    await waitFor(() => expect(screen.getByText('new draft').tagName).toBe('PRE')); 
  });
  it('offers no editor to readers', async () => { preview(false); await screen.findByText('original'); expect(screen.queryByRole('button', { name: 'Edit text' })).toBeNull(); });
  it('offers no editor for a truncated preview', async () => { preview(true, 'x'.repeat(200_001)); await screen.findByText(/Cut off here/); expect(screen.queryByRole('button', { name: 'Edit text' })).toBeNull(); });
  it('offers no editor when the stored bytes are invalid UTF-8', async () => {
    const p = preview(true, '', true); await screen.findByRole('button', { name: 'Retry preview' }); expect(p.onError).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Edit text' })).toBeNull();
  });
});
