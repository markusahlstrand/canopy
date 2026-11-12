import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DriveScreen } from './drive';
vi.mock('./live-updates', () => ({ watchDriveChanges: () => () => {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const shell = { onError: () => {}, auth: { user: {} }, onSignIn: () => {}, onSignOut: () => {} };

const folders: Record<string, unknown[]> = {
  '/api/folders/root/folders': [
    { id: '01F', parent_id: 'root', name: 'Fiscal', path: 'Fiscal' },
    { id: '01H', parent_id: 'root', name: 'Houses', path: 'Houses' },
  ],
  '/api/folders/01F/folders': [{ id: '01I', parent_id: '01F', name: 'IVA', path: 'Fiscal/IVA' }],
};

/** A space bound to `provider` (or to nothing); every request is recorded. */
function space(provider: string | null) {
  const source = provider && { provider, connectionId: 'c1', account: 'ACME', folder: '', canUpload: true, boundAt: '2026-10-31T09:00:00.000Z' };
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    if (init?.method === 'POST') return Response.json({ id: 'up', name: 'a.pdf' });
    return Response.json(url === '/api/source' ? { source } : url.endsWith('/access') ? { canManage: false } : folders[url] ?? []);
  }));
  return { uploads: () => calls.filter(call => call.method === 'POST').map(call => call.url) };
}

/** The listing is up and the space's source answer has landed. */
async function ready() {
  await screen.findByText('Houses');
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/source')).toBe(true));
  await act(async () => {});
}

const choose = (container: HTMLElement) =>
  fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [new File(['a'], 'a.pdf')] } });

it('asks an a3doc space which other categories to file under, and sends them along', async () => {
  const { uploads } = space('canopy.a3doc');
  const { container } = render(<DriveScreen {...shell} />);
  await ready();
  choose(container);
  await screen.findByRole('dialog', { name: 'File under categories' });
  expect(uploads()).toEqual([]);
  fireEvent.click(await screen.findByLabelText('Fiscal/IVA'));
  fireEvent.click(screen.getByLabelText('Houses'));
  fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
  await waitFor(() => expect(uploads()).toEqual(['/api/folders/root/content?name=a.pdf&alsoIn=01I&alsoIn=01H']));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('narrows the list with the filter', async () => {
  space('canopy.a3doc');
  const { container } = render(<DriveScreen {...shell} />);
  await ready();
  choose(container);
  await screen.findByLabelText('Fiscal/IVA');
  fireEvent.change(screen.getByLabelText('Filter categories'), { target: { value: 'iva' } });
  expect(screen.queryByLabelText('Houses')).toBeNull();
  expect(screen.getByLabelText('Fiscal/IVA')).toBeTruthy();
});

it('uploads nothing when the category pick is cancelled', async () => {
  const { uploads } = space('canopy.a3doc');
  render(<DriveScreen {...shell} />);
  await ready();
  fireEvent.drop(screen.getByLabelText('File upload area'), { dataTransfer: { types: ['Files'], files: [new File(['a'], 'a.pdf')], items: [] } });
  await screen.findByRole('dialog', { name: 'File under categories' });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(uploads()).toEqual([]);
});

it('uploads straight away in a space not bound to a3doc', async () => {
  const { uploads } = space(null);
  const { container } = render(<DriveScreen {...shell} />);
  await ready();
  choose(container);
  await waitFor(() => expect(uploads()).toEqual(['/api/folders/root/content?name=a.pdf']));
  expect(screen.queryByRole('dialog')).toBeNull();
});
