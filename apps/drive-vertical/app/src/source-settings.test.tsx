import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SourceSettings } from './source-settings';
import { actionsFor } from './file-table';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const connected = { provider: 'canopy.a3doc', connectionId: 'c1', account: 'ACME', folder: 'Facturas', canUpload: false, boundAt: '2026-10-31T09:00:00.000Z' };

function platform(options: { refuse?: string } = {}) {
  let source: typeof connected | null = null;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/source/status')) return Response.json({ source, binding: source && { status: 'active', lastSyncedAt: null, lastError: { at: '2026-10-31T09:05:00.000Z', message: 'a3doc did not answer' } } });
    if (init?.method === 'PUT') {
      if (options.refuse) return Response.json({ detail: options.refuse }, { status: 409 });
      source = connected;
      return Response.json(source);
    }
    if (init?.method === 'DELETE') { source = null; return new Response(null, { status: 204 }); }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

it('connects a space with the a3doc login and shows what it mirrors and how it syncs', async () => {
  const fetcher = platform(), changed = vi.fn();
  render(<SourceSettings disabled={false} onChanged={changed} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect a3doc' }));
  expect(screen.getByRole('group', { name: 'Connect a3doc' })).toBeTruthy();
  const connect = screen.getByRole('button', { name: 'Connect' });
  expect((connect as HTMLButtonElement).disabled).toBe(true);
  for (const [label, value] of [['Company code', 'ACME'], ['User', 'ana'], ['Password', 'pw'], ['a3doc folder', 'Facturas']]) {
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
  }
  fireEvent.click(connect);
  await screen.findByText('a3doc · ACME');
  const put = fetcher.mock.calls.find(([, init]) => init?.method === 'PUT')!;
  expect(JSON.parse(put[1]!.body as string)).toEqual({ companyCode: 'ACME', user: 'ana', password: 'pw', folder: 'Facturas' });
  expect(changed).toHaveBeenCalledOnce();
  expect(screen.getByText(/can only read, so nothing can be uploaded/)).toBeTruthy();
  expect(screen.getByText(/Last sync failed .*a3doc did not answer/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
  await screen.findByText('Canopy storage');
  expect(changed).toHaveBeenCalledTimes(2);
});

it('keeps the form and says why when a3doc refuses the folder', async () => {
  platform({ refuse: "no a3doc folder at 'Nope'" });
  render(<SourceSettings disabled={false} onChanged={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect a3doc' }));
  for (const [label, value] of [['Company code', 'ACME'], ['User', 'ana'], ['Password', 'pw'], ['a3doc folder', 'Nope']]) {
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
  }
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  expect((await screen.findByRole('alert')).textContent).toContain("no a3doc folder at 'Nope'");
  await waitFor(() => expect((screen.getByLabelText('a3doc folder') as HTMLInputElement).value).toBe('Nope'));
});

it('offers only what a3doc can do on a mirrored row', () => {
  const file = { id: 'f', name: 'a.pdf', isFolder: false } as Parameters<typeof actionsFor>[0];
  const folder = { ...file, isFolder: true };
  expect(actionsFor(file, false, false, true)).toEqual(['Open', 'Download']);
  expect(actionsFor(folder, false, false, true)).toEqual(['Open', 'Share']);
  expect(actionsFor(file, false, true, true)).toEqual([]);
});
