/**
 * The open preview follows the listing (#291): a rename, a head written by another
 * session, and a move to Trash all used to leave the panel describing the file as it was.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DriveScreen } from './drive';
import { PreviewPanel } from './preview';
import { useUnsavedDraft } from './drafts';
vi.mock('./live-updates', () => ({ watchDriveChanges: () => () => {} }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const version = (id: string, size: number, created_at: string) =>
  ({ id, file_id: 'a', source: 'blob', blob_ref: `${id}-blob`, mime: 'text/plain', size, keep: 0, created_at });
const v2 = version('v2', 62, '2026-09-01T00:00:00Z');
const v3 = version('v3', 79, '2026-09-02T00:00:00Z');
const v4 = version('v4', 63, '2026-09-03T00:00:00Z');

/** One file on a server whose state the test changes behind the screen's back. */
function server(mime = 'text/plain') {
  const state = { name: 's12a-note.txt', head: v2, history: [v2], trashed: false };
  const typed = (v: typeof v2) => ({ ...v, mime });
  const row = () => ({ id: 'a', folder_id: 'root', name: state.name, current_version_id: state.head.id, created_at: '', updated_at: '', deleted_at: null });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/files/a/content') && method === 'PUT') {
      if (!url.endsWith(`expectedVersion=${state.head.id}`)) return json({ detail: 'changed' }, 409);
      return json(row(), 201);
    }
    if (url.endsWith('/content')) return new Response(`text of ${url.split('/')[5]}`);
    if (url === '/api/folders/root/files') return json(state.trashed ? [] : [row()]);
    if (url === '/api/files/a' && method === 'PATCH') { state.name = JSON.parse(init!.body as string).name; return json(row()); }
    if (url === '/api/files/a' && method === 'DELETE') { state.trashed = true; return json(row()); }
    if (url === '/api/files/a') return json({ file: row(), version: typed(state.head), canWrite: true });
    if (url === '/api/files/a/versions') return json(state.history.map(typed));
    if (url === '/api/files/a/text') return json({ id: 't', file_id: 'a', version_id: state.head.id, status: 'indexed', chars: state.head.size, extracted_at: null, detail: null });
    if (url.startsWith('/api/search?')) return json({ hits: [{ ...row(), via: 'name' }] });
    if (url.endsWith('/access')) return json({ canManage: false });
    return json([]);
  });
  vi.stubGlobal('fetch', fetch);
  return { state, fetch };
}

const panel = () => screen.getByRole('complementary', { name: 'Preview' });
const metaReads = (fetch: ReturnType<typeof server>['fetch']) =>
  fetch.mock.calls.filter(([url, init]) => url === '/api/files/a' && (init?.method ?? 'GET') === 'GET').length;

async function openPreview() {
  render(<DriveScreen auth={{ user: {} }} onError={() => {}} onSignIn={() => {}} onSignOut={() => {}} />);
  fireEvent.doubleClick(await screen.findByText('s12a-note.txt'));
  await within(panel()).findByText('text of v2');
}

it('renames the open preview with its row', async () => {
  server();
  await openPreview();
  fireEvent.contextMenu(screen.getByRole('row', { name: /s12a-note\.txt/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Rename file' }), { target: { value: 's12a-note-renamed.txt' } });
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
  await waitFor(() => expect(within(panel()).getByRole('heading', { name: 's12a-note-renamed.txt' })).toBeTruthy());
  expect(within(panel()).getByText('text of v2')).toBeTruthy();
});

it('keeps the stale base while editing, then follows the newer head once editing is cancelled', async () => {
  const { state, fetch } = server();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await openPreview();
  fireEvent.click(within(panel()).getByRole('button', { name: 'Edit text' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'File text' }), { target: { value: 'my draft' } });
  const readsBefore = metaReads(fetch);
  const listings = () => fetch.mock.calls.filter(([url]) => url === '/api/folders/root/files').length;

  // Another session writes v3, and the listing learns of it while the draft is open.
  state.head = v3; state.history = [v3, v2];
  let seen = listings();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(listings()).toBeGreaterThan(seen));
  expect(metaReads(fetch)).toBe(readsBefore);

  // The editor's base is still v2, so the save meets the 409 and the draft survives.
  seen = listings();
  fireEvent.click(screen.getByRole('button', { name: 'Save text' }));
  await within(panel()).findByRole('alert');
  expect(fetch).toHaveBeenCalledWith('/api/files/a/content?expectedVersion=v2', expect.objectContaining({ method: 'PUT' }));
  expect((screen.getByRole('textbox', { name: 'File text' }) as HTMLTextAreaElement).value).toBe('my draft');
  // The conflict asks the listing to catch up; the panel still does not move under the draft.
  await waitFor(() => expect(listings()).toBeGreaterThan(seen));
  expect(metaReads(fetch)).toBe(readsBefore);
  expect(screen.getByDisplayValue('my draft')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }));
  await within(panel()).findByText('text of v3');
  fireEvent.click(within(panel()).getByRole('button', { name: 'Versions' }));
  const current = await within(panel()).findByText('current');
  expect(current.closest('li')?.textContent).toContain('79 B');
  const rows = within(panel()).getAllByRole('listitem');
  expect(within(rows.find(li => li.textContent?.includes('79 B'))!).queryByRole('button', { name: 'Restore' })).toBeNull();
  expect(within(rows.find(li => li.textContent?.includes('62 B'))!).getByRole('button', { name: 'Restore' })).toBeTruthy();
});

it('does not re-read the file while the listing agrees with the panel', async () => {
  const { fetch } = server();
  await openPreview();
  const reads = metaReads(fetch);
  fireEvent.click(within(panel()).getByRole('button', { name: 'Edit text' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }));
  await within(panel()).findByRole('button', { name: 'Edit text' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url === '/api/folders/root/files').length).toBeGreaterThan(1));
  expect(metaReads(fetch)).toBe(reads);
});

it('closes the preview when its file is moved to Trash from the row menu', async () => {
  const { fetch } = server();
  await openPreview();
  fireEvent.contextMenu(screen.getByRole('row', { name: /s12a-note\.txt/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
  await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Preview' })).toBeNull());
  expect(fetch).toHaveBeenCalledWith('/api/files/a', expect.objectContaining({ method: 'DELETE' }));
});

it('reloads an open version history when the head moves, without telling the listing', async () => {
  const { state } = server();
  const changed = vi.fn();
  const props = { fileId: 'a', onClose: () => {}, onError: () => {}, onChanged: changed };
  const view = render(<PreviewPanel {...props} listed={{ name: state.name, currentVersionId: 'v2' }} />);
  await screen.findByText('text of v2');
  fireEvent.click(screen.getByRole('button', { name: 'Versions' }));
  expect((await screen.findByText('current')).closest('li')?.textContent).toContain('62 B');
  state.head = v3; state.history = [v3, v2];
  view.rerender(<PreviewPanel {...props} listed={{ name: state.name, currentVersionId: 'v3' }} />);
  await waitFor(() => expect(screen.getByText('current').closest('li')?.textContent).toContain('79 B'));
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(changed).not.toHaveBeenCalled();
});

it('never moves a clean editor off its base, so a later save still meets the 409', async () => {
  const { state, fetch } = server();
  const props = { fileId: 'a', onClose: () => {}, onError: () => {} };
  const view = render(<PreviewPanel {...props} listed={{ name: state.name, currentVersionId: 'v2' }} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit text' }));
  state.head = v3; state.history = [v3, v2];
  view.rerender(<PreviewPanel {...props} listed={{ name: state.name, currentVersionId: 'v3' }} />);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect((screen.getByRole('textbox', { name: 'File text' }) as HTMLTextAreaElement).value).toBe('text of v2');
  fireEvent.change(screen.getByRole('textbox', { name: 'File text' }), { target: { value: 'my draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save text' }));
  await screen.findByRole('alert');
  expect(fetch).toHaveBeenCalledWith('/api/files/a/content?expectedVersion=v2', expect.objectContaining({ method: 'PUT' }));
});

it('re-reads an open Text tab when the head moves', async () => {
  const { state } = server();
  const props = { fileId: 'a', onClose: () => {}, onError: () => {} };
  const view = render(<PreviewPanel {...props} listed={{ name: state.name, currentVersionId: 'v2' }} />);
  await screen.findByText('text of v2');
  fireEvent.click(screen.getByRole('button', { name: 'Text' }));
  await screen.findByText('62 characters, searchable.');
  state.head = v3; state.history = [v3, v2];
  view.rerender(<PreviewPanel {...props} listed={{ name: state.name, currentVersionId: 'v3' }} />);
  await screen.findByText('79 characters, searchable.');
});

it('lets a restore in flight finish before following the listing', async () => {
  const { state, fetch } = server();
  state.head = v3; state.history = [v3, v2];
  let land!: () => void;
  const base = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (!url.endsWith('/versions/v2/restore')) return base(url, init);
    await new Promise<void>(resolve => { land = resolve; });
    state.head = v4; state.history = [v4, v3, v2];
    return new Response(JSON.stringify({}));
  });
  const changed = vi.fn();
  const props = { fileId: 'a', onClose: () => {}, onError: () => {}, onChanged: changed };
  const view = render(<PreviewPanel {...props} listed={{ name: state.name, currentVersionId: 'v3' }} />);
  await screen.findByText('text of v3');
  fireEvent.click(screen.getByRole('button', { name: 'Versions' }));
  const old = (await screen.findByText('62 B')).closest('li')!;
  fireEvent.click(within(old).getByRole('button', { name: 'Restore' }));
  fireEvent.click(within(old).getByRole('button', { name: 'Confirm restore' }));
  // The listing moves while the restore is still on the wire.
  view.rerender(<PreviewPanel {...props} listed={{ name: state.name, currentVersionId: 'v4' }} />);
  await act(async () => { land(); });
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(screen.getByText('current').closest('li')?.textContent).toContain('63 B');
  expect(screen.getAllByRole('button', { name: 'Keep' }).every(button => !(button as HTMLButtonElement).disabled)).toBe(true);
});

it('follows a rename made from search results', async () => {
  server();
  render(<DriveScreen auth={{ user: {} }} onError={() => {}} onSignIn={() => {}} onSignOut={() => {}} />);
  await screen.findByText('s12a-note.txt');
  fireEvent.change(screen.getByRole('textbox', { name: 'Search this space' }), { target: { value: 's12a' } });
  await waitFor(() => expect(screen.getByRole('row', { name: /s12a-note\.txt/ }).textContent).toContain('Matched in the name'));
  fireEvent.doubleClick(screen.getByRole('row', { name: /s12a-note\.txt/ }));
  await within(panel()).findByText('text of v2');
  fireEvent.contextMenu(screen.getByRole('row', { name: /s12a-note\.txt/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Rename file' }), { target: { value: 's12a-note-renamed.txt' } });
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
  await waitFor(() => expect(within(panel()).getByRole('heading', { name: 's12a-note-renamed.txt' })).toBeTruthy());
});

it('holds the head still while an unsaved draft is open (a plugin editor remounts per version)', async () => {
  const { state, fetch } = server();
  const Draft = () => { useUnsavedDraft(true); return null; };
  const props = { fileId: 'a', onClose: () => {}, onError: () => {} };
  const view = render(<><Draft /><PreviewPanel {...props} listed={{ name: state.name, currentVersionId: 'v2' }} /></>);
  await screen.findByText('text of v2');
  const reads = metaReads(fetch);
  state.head = v3; state.history = [v3, v2];
  view.rerender(<><Draft /><PreviewPanel {...props} listed={{ name: state.name, currentVersionId: 'v3' }} /></>);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(metaReads(fetch)).toBe(reads);
  expect(screen.getByText('text of v2')).toBeTruthy();
});

it('re-reads the text behind an open Table tab when the head moves', async () => {
  const { state } = server('text/csv');
  const props = { fileId: 'a', onClose: () => {}, onError: () => {} };
  const view = render(<PreviewPanel {...props} listed={{ name: state.name, currentVersionId: 'v2' }} />);
  await screen.findByText('text of v2');
  fireEvent.click(screen.getByRole('button', { name: 'Table' }));
  await screen.findByRole('cell', { name: 'text of v2' });
  state.head = v3; state.history = [v3, v2];
  view.rerender(<PreviewPanel {...props} listed={{ name: state.name, currentVersionId: 'v3' }} />);
  await screen.findByRole('cell', { name: 'text of v3' });
});
