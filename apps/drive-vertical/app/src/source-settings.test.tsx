import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SourceSettings, sourceSyncNote } from './source-settings';
import type { SourceStatus } from './api';
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

it('connects on Enter in a login field, because the settings form around it would save instead', async () => {
  const fetcher = platform();
  render(<form onSubmit={() => { throw new Error('the space form must not submit'); }}><SourceSettings disabled={false} onChanged={() => {}} /></form>);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect a3doc' }));
  for (const [label, value] of [['Company code', 'ACME'], ['User', 'ana'], ['Password', 'pw']]) {
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
  }
  expect(fireEvent.keyDown(screen.getByLabelText('Password'), { key: 'Enter' })).toBe(false);
  await screen.findByText('a3doc · ACME');
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
});

it('swallows Enter on an unfinished login, and shows a refusal beside the Connect button', async () => {
  const fetcher = platform({ refuse: 'a3doc refused the login' });
  render(<SourceSettings disabled={false} onChanged={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect a3doc' }));
  fireEvent.change(screen.getByLabelText('User'), { target: { value: 'ana' } });
  expect(fireEvent.keyDown(screen.getByLabelText('User'), { key: 'Enter' })).toBe(false);
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  fireEvent.change(screen.getByLabelText('Company code'), { target: { value: 'ACME' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  expect(screen.getByRole('group', { name: 'Connect a3doc' }).contains(await screen.findByRole('alert'))).toBe(true);
});

it('reports a login being typed, and that it ended once connected', async () => {
  platform();
  const draft = vi.fn();
  render(<SourceSettings disabled={false} onChanged={() => {}} onDraftChange={draft} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect a3doc' }));
  expect(draft).toHaveBeenLastCalledWith(false);
  for (const [label, value] of [['Company code', 'ACME'], ['User', 'ana'], ['Password', 'pw']]) {
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
  }
  expect(draft).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await screen.findByText('a3doc · ACME');
  // The draft flag is reported from an effect, which can land a beat after the connected line renders.
  await waitFor(() => expect(draft).toHaveBeenLastCalledWith(false));
});

it('counts any typed login field as a draft, but not a prefilled Connect again form', async () => {
  platform();
  const draft = vi.fn();
  const { unmount } = render(<SourceSettings disabled={false} onChanged={() => {}} onDraftChange={draft} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect a3doc' }));
  fireEvent.change(screen.getByLabelText('Company code'), { target: { value: 'ACME' } });
  expect(draft).toHaveBeenLastCalledWith(true);
  fireEvent.change(screen.getByLabelText('Company code'), { target: { value: '' } });
  expect(draft).toHaveBeenLastCalledWith(false);
  fireEvent.change(screen.getByLabelText('a3doc folder'), { target: { value: 'Facturas' } });
  expect(draft).toHaveBeenLastCalledWith(true);
  fireEvent.change(screen.getByLabelText('Company code'), { target: { value: 'ACME' } });
  fireEvent.change(screen.getByLabelText('User'), { target: { value: 'ana' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await screen.findByText('a3doc · ACME');
  unmount();
  draft.mockClear();
  render(<SourceSettings disabled={false} onChanged={() => {}} onDraftChange={draft} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect again' }));
  expect((screen.getByLabelText('Company code') as HTMLInputElement).value).toBe('ACME');
  expect(draft).not.toHaveBeenCalledWith(true);
});

it('leaves Enter alone while an input method is composing', async () => {
  const fetcher = platform();
  render(<SourceSettings disabled={false} onChanged={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect a3doc' }));
  for (const [label, value] of [['Company code', 'ACME'], ['User', 'ana'], ['Password', 'pw']]) {
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
  }
  const folder = screen.getByLabelText('a3doc folder');
  expect(fireEvent.keyDown(folder, { key: 'Enter', isComposing: true })).toBe(true);
  expect(fireEvent.keyDown(folder, { key: 'Enter', keyCode: 229 })).toBe(true);
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
});

it('offers only what a3doc can do on a mirrored row', () => {
  const file = { id: 'f', name: 'a.pdf', isFolder: false } as Parameters<typeof actionsFor>[0];
  const folder = { ...file, isFolder: true };
  expect(actionsFor(file, false, false, true)).toEqual(['Open', 'Download']);
  expect(actionsFor(folder, false, false, true)).toEqual(['Open', 'Share']);
  expect(actionsFor(file, false, true, true)).toEqual([]);
});

const status = (over: Partial<SourceStatus> = {}): SourceStatus => ({ source: connected, binding: { status: 'active', lastSyncedAt: '2026-11-06T22:00:00.000Z', lastError: null }, report: null, ...over });
const read = { at: '2026-11-06T22:00:00.000Z', complete: true, total: 2, read: 2, skipped: 0, skippedContainers: [], files: 2 };

it('says what a sync found, a current failure first', () => {
  expect(sourceSyncNote(status({ source: null }))).toBeNull();
  expect(sourceSyncNote(status({ binding: { status: 'active', lastSyncedAt: null, lastError: null } }))?.text).toMatch(/^Not synced yet/);
  expect(sourceSyncNote(status({ report: { ...read, total: 0, read: 0, files: 0 } }))).toMatchObject({ failed: true, text: expect.stringContaining('a3doc listed no documents') });
  expect(sourceSyncNote(status({ report: { ...read, complete: false, read: 1 } }))).toEqual({ failed: false, text: 'Syncing: read 1 of 2 documents so far.' });
  expect(sourceSyncNote(status({ report: read }))?.text).toContain('2 of 2 documents, 2 here.');
  expect(sourceSyncNote(status({ report: read, binding: { status: 'active', lastSyncedAt: null, lastError: { at: '2026-11-06T22:05:00.000Z', message: 'a3doc refused' } } }))).toMatchObject({ failed: true, text: expect.stringContaining('a3doc refused') });
});
