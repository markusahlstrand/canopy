import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, within, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PreviewPanel } from './preview';

const old = { keep: 0, id: 'old', file_id: 'file', source: 'blob', blob_ref: 'old-blob', mime: 'application/zip', size: 1, created_at: '2026-08-01T00:00:00Z' };
const current = { ...old, id: 'current', blob_ref: 'current-blob', created_at: '2026-09-01T00:00:00Z' };
const file = { id: 'file', name: 'archive.zip', current_version_id: 'current' };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mockHistory(canWrite = true, fail = false) {
  let restored = false;
  let kept = false;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/comments')) return new Response(JSON.stringify([{ id: 'comment', body: 'Preview thread', authorLabel: 'Ada', created_at: old.created_at, canDelete: false }]));
    if (url.endsWith('/details')) return new Response(JSON.stringify({ fileId: 'file', description: 'Details in preview', labels: [], revision: 0, canWrite }));
    if (init?.method === 'PATCH') {
      if (fail) return new Response('refused', { status: 403 });
      kept = JSON.parse(init.body as string).keep;
      return new Response(JSON.stringify({ ...old, keep: kept ? 1 : 0 }));
    }
    if (init?.method === 'POST') {
      if (fail) return new Response('refused', { status: 403 });
      restored = true;
    }
    const version = restored ? { ...old, id: 'restored' } : current;
    const body = url.endsWith('/versions') ? (restored ? [version, current, old] : [current, old]) : { file, version, canWrite };
    return new Response(JSON.stringify(body));
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function versions(onError = vi.fn(), onChanged = vi.fn()) {
  render(<PreviewPanel fileId="file" onClose={() => {}} onError={onError} onChanged={onChanged} />);
  await screen.findByText('archive.zip');
  fireEvent.click(screen.getByRole('button', { name: 'Versions' }));
  await screen.findByRole('link', { name: `Download version from ${new Date(old.created_at).toLocaleString()}` });
}

describe('restoring from version history', () => {
  it('mounts a comment thread when Comments is selected', async () => {
    mockHistory(false);
    render(<PreviewPanel fileId="file" onClose={() => {}} onError={() => {}} />);
    await screen.findByText('archive.zip');
    fireEvent.click(screen.getByRole('button', { name: 'Comments' }));
    await screen.findByText('Preview thread');
  });

  it('mounts descriptive metadata when the Details tab is selected', async () => {
    mockHistory(false);
    render(<PreviewPanel fileId="file" onClose={() => {}} onError={() => {}} />);
    await screen.findByText('archive.zip');
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    await screen.findByText('Details in preview');
  });

  it('confirms before writing and refreshes the current marker and parent listing', async () => {
    const fetch = mockHistory();
    const changed = vi.fn();
    await versions(vi.fn(), changed);
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm restore' }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith('/api/files/file/versions/old/restore', expect.objectContaining({ method: 'POST' }));
    expect(screen.getByText('current').closest('li')?.textContent).toContain(new Date(old.created_at).toLocaleString());
  });

  it('keeps and unkeeps an old version using the historical endpoint', async () => {
    const fetch = mockHistory();
    await versions();
    const row = screen.getByRole('link', { name: `Download version from ${new Date(old.created_at).toLocaleString()}` }).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(within(row).getByText('kept')).toBeTruthy());
    expect(fetch).toHaveBeenCalledWith('/api/files/file/versions/old', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ keep: true }) }));
    fireEvent.click(within(row).getByRole('button', { name: 'Unkeep' }));
    await waitFor(() => expect(within(row).queryByText('kept')).toBeNull());
  });

  it('leaves the flag unchanged after a refused keep request', async () => {
    mockHistory(true, true);
    const error = vi.fn();
    await versions(error);
    const row = screen.getByRole('link', { name: `Download version from ${new Date(old.created_at).toLocaleString()}` }).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(within(row).queryByText('kept')).toBeNull();
    expect((within(row).getByRole('button', { name: 'Keep' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows no restore action to a reader', async () => {
    mockHistory(false);
    await versions();
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Keep' })).toBeNull();
  });

  it('keeps the selected version available for retry after refusal', async () => {
    mockHistory(true, true);
    const error = vi.fn();
    const changed = vi.fn();
    await versions(error, changed);
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm restore' }));
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(changed).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Confirm restore' }) as HTMLButtonElement).disabled).toBe(false);
  });
});


describe('paged history', () => {
  it('retires an older-page response when the preview changes files', async () => {
    let finishOlder!: (response: Response) => void;
    const fetch = vi.fn((url: string) => {
      if (url.includes('cursor=')) return new Promise<Response>(resolve => { finishOlder = resolve; });
      const second = url.includes('/file2');
      if (url.endsWith('/versions')) return Promise.resolve(new Response(JSON.stringify([second ? { ...current, id: 'current2', file_id: 'file2' } : current]), {
        headers: second ? {} : { Link: `<${window.location.origin}/api/files/file/versions?cursor=current>; rel="next"` },
      }));
      return Promise.resolve(new Response(JSON.stringify({ file: second ? { ...file, id: 'file2', name: 'second.zip' } : file, version: second ? { ...current, id: 'current2', file_id: 'file2' } : current, canWrite: false })));
    });
    vi.stubGlobal('fetch', fetch);
    const error = vi.fn();
    const view = render(<PreviewPanel fileId="file" onClose={() => {}} onError={error} />);
    await screen.findByText('archive.zip');
    fireEvent.click(screen.getByRole('button', { name: 'Versions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Load older versions' }));
    view.rerender(<PreviewPanel fileId="file2" onClose={() => {}} onError={error} />);
    await screen.findByText('second.zip');
    fireEvent.click(screen.getByRole('button', { name: 'Versions' }));
    await screen.findByText('current');
    await act(async () => finishOlder(new Response(JSON.stringify([old]))));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByRole('link', { name: `Download version from ${new Date(old.created_at).toLocaleString()}` })).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it('loads older pages without replacing current rows and retries a failed page', async () => {
    let olderReads = 0;
    const origin = window.location.origin;
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('cursor=')) {
        olderReads++;
        if (olderReads === 1) return new Response(JSON.stringify({ detail: 'Try again' }), { status: 503 });
        // Duplicate current proves appending a retried page does not duplicate history rows.
        return new Response(JSON.stringify([current, old]));
      }
      if (url.endsWith('/versions')) return new Response(JSON.stringify([current]), {
        headers: { Link: `<${origin}/api/files/file/versions?cursor=current&limit=1>; rel="next"` },
      });
      return new Response(JSON.stringify({ file, version: current, canWrite: false }));
    });
    vi.stubGlobal('fetch', fetch);
    const error = vi.fn();
    render(<PreviewPanel fileId="file" onClose={() => {}} onError={error} />);
    await screen.findByText('archive.zip');
    fireEvent.click(screen.getByRole('button', { name: 'Versions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Load older versions' }));
    await waitFor(() => expect(error).toHaveBeenCalledWith('Try again'));
    expect(screen.getByText('current')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load older versions' }));
    await screen.findByRole('link', { name: `Download version from ${new Date(old.created_at).toLocaleString()}` });
    expect(fetch).toHaveBeenCalledWith('/api/files/file/versions?cursor=current&limit=1', expect.anything());
    expect(screen.queryByRole('button', { name: 'Load older versions' })).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
