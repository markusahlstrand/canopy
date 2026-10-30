import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CommandPalette } from './command-palette';
import { openSpaceFile } from './space-navigation';

vi.mock('./space-navigation', async (importOriginal) => ({ ...await importOriginal<typeof import('./space-navigation')>(), openSpaceFile: vi.fn(() => true) }));
import type { PluginInstall } from './api';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const props = { open: true, onOpenChange: vi.fn(), files: [], onNavigate: vi.fn(), onOpenFile: vi.fn(), onUpload: vi.fn() };
it('omits upload when the drive cannot accept writes', () => {
  render(<CommandPalette {...props} onUpload={undefined} />);
  expect(screen.queryByRole('option', { name: 'Upload' })).toBeNull();
  expect(screen.getByRole('option', { name: /My Drive/ })).toBeTruthy();
});
it('explains the minimum file search length before a request starts', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  render(<CommandPalette {...props} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'x' } });
  expect(screen.getByText('Type at least 2 characters to search files.')).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});
it('offers saved folders without making a file search request while offline', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const folder = { id: 'saved', name: 'Saved folder', kind: 'folder' as const, modified: '', size: '—', isFolder: true };
  render(<CommandPalette {...props} offline files={[folder]} />);
  expect(screen.getByRole('status').textContent).toContain('File search is unavailable while offline');
  expect(screen.getByRole('option', { name: /Saved folder/ })).toBeTruthy();
  expect(screen.queryByRole('option', { name: 'Search this space' })).toBeNull();
  expect(screen.queryByRole('option', { name: 'Trash' })).toBeNull();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'budget' } });
  expect(fetch).not.toHaveBeenCalled();
});
it('distinguishes failed search from no matches and retries the same query', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce(new Response(JSON.stringify({ hits: [] })));
  vi.stubGlobal('fetch', fetch);
  render(<CommandPalette {...props} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'budget' } });
  expect(screen.getByRole('status').textContent).toBe('Searching…');
  await screen.findByText('Connection lost');
  expect(screen.queryByText('No results found.')).toBeNull();
  const retry = screen.getByRole('option', { name: 'Retry search' });
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
  expect(retry.getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  expect(screen.queryByText('No results found.')).toBeNull();
  await screen.findByText('No results found.');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
});
it('retires a pending answer when the palette closes', async () => {
  let finish!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { finish = resolve; })));
  const view = render(<CommandPalette {...props} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'budget' } });
  await vi.waitFor(() => expect(finish).toBeDefined());
  view.rerender(<CommandPalette {...props} open={false} />);
  view.rerender(<CommandPalette {...props} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'current query' } });
  await act(async () => { finish(new Response(JSON.stringify({ hits: [{ id: 'old', name: 'Old result', via: 'name' }] }))); });
  expect(screen.queryByText('Old result')).toBeNull();
});
it('keeps B results when the retired A request resolves last', async () => {
  const pending: ((response: Response) => void)[] = [];
  vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { pending.push(resolve as (response: Response) => void); })));
  render(<CommandPalette {...props} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'query A' } });
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'query B' } });
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  await act(async () => { pending[1]!(new Response(JSON.stringify({ hits: [{ id: 'b', name: 'B result', via: 'name' }] }))); });
  expect(screen.getByRole('option', { name: /^B result/ })).toBeTruthy();
  await act(async () => { pending[0]!(new Response(JSON.stringify({ hits: [{ id: 'a', name: 'A result', via: 'name' }] }))); });
  expect(screen.queryByRole('option', { name: /^A result/ })).toBeNull();
  expect(screen.getByRole('option', { name: /^B result/ })).toBeTruthy();
});

it('shows no-results only after the active query settles', async () => {
  const pending: ((response: Response) => void)[] = [];
  vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { pending.push(resolve as (response: Response) => void); })));
  render(<CommandPalette {...props} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'missing' } });
  expect(screen.queryByText('No results found.')).toBeNull();
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => { pending[0]!(new Response(JSON.stringify({ hits: [] }))); });
  expect(screen.getByText('No results found.')).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'another' } });
  expect(screen.queryByText('No results found.')).toBeNull();
});

it('offers Shared with me as a keyboard-selectable navigation destination', () => {
  const onNavigate = vi.fn();
  const onOpenChange = vi.fn();
  render(<CommandPalette {...props} onNavigate={onNavigate} onOpenChange={onOpenChange} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Shared with me' } });
  const shared = screen.getByRole('option', { name: 'Shared with me' });
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
  expect(shared.getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  expect(onNavigate).toHaveBeenCalledWith('shared');
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
it('stays open when a draft blocks navigation', () => {
  const onOpenChange = vi.fn();
  render(<CommandPalette {...props} onOpenChange={onOpenChange} onNavigate={() => false} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Shared with me' } });
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
});
it('keeps search open when showing all results is blocked', () => {
  const onOpenChange = vi.fn();
  render(<CommandPalette {...props} onOpenChange={onOpenChange} onShowAllResults={() => false} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'budget' } });
  fireEvent.click(screen.getByRole('option', { name: /Show all results for/ }));
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
});
it('stays open when a draft blocks opening a file', () => {
  const onOpenChange = vi.fn();
  const item = { id: 'report', name: 'Report', kind: 'doc' as const, modified: '', size: '—', isFolder: false };
  render(<CommandPalette {...props} files={[item]} onOpenChange={onOpenChange} onOpenFile={() => false} />);
  fireEvent.click(screen.getByRole('option', { name: /Report/ }));
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
});
it('switches to a space selected from the palette', () => {
  const onOpenSpace = vi.fn();
  render(<CommandPalette {...props} sites={[{slug:'team',name:'Team',current:false}]} onOpenSpace={onOpenSpace} />);
  fireEvent.change(screen.getByRole('combobox'), {target:{value:'Team'}});
  const option = screen.getByRole('option', {name:'Team'});
  fireEvent.keyDown(screen.getByRole('combobox'), {key:'ArrowDown'});
  expect(option.getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(screen.getByRole('combobox'), {key:'Enter'});
  expect(onOpenSpace).toHaveBeenCalledWith('team');
});
it('offers an unnamed space by its slug', () => {
  render(<CommandPalette {...props} sites={[{slug:'legacy-space',name:' ',current:false}]} onOpenSpace={vi.fn()} />);
  expect(screen.getByRole('option', {name:'legacy-space'})).toBeTruthy();
});
it('does not reload the current space from the palette', () => {
  const onOpenSpace = vi.fn();
  const onOpenChange = vi.fn();
  render(<CommandPalette {...props} onOpenChange={onOpenChange} sites={[{slug:'team',name:'Team',current:true}]} onOpenSpace={onOpenSpace} />);
  fireEvent.change(screen.getByRole('combobox'), {target:{value:'Team'}});
  fireEvent.keyDown(screen.getByRole('combobox'), {key:'ArrowDown'});
  fireEvent.keyDown(screen.getByRole('combobox'), {key:'Enter'});
  expect(onOpenSpace).not.toHaveBeenCalled();
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
it('hides space switching when no switch callback is available', () => {
  render(<CommandPalette {...props} sites={[{slug:'team',name:'Team',current:false}]} />);
  expect(screen.queryByRole('option', {name:'Team'})).toBeNull();
});
it('opens an installed app from the palette', () => {
  const row: PluginInstall = {id:'install-1',plugin_id:'notes',principal:'space',enabled:1,updated_at:'now',manifest_json:JSON.stringify({id:'notes',name:'Notes',version:'1',capabilities:[],contributes:{detailView:{id:'notes',title:'Notes app'}}})};
  const onOpenPlugin = vi.fn();
  render(<CommandPalette {...props} pluginApps={[row]} onOpenPlugin={onOpenPlugin} />);
  fireEvent.change(screen.getByRole('combobox'), {target:{value:'Notes app'}});
  const option = screen.getByRole('option', {name:'Notes app'});
  fireEvent.keyDown(screen.getByRole('combobox'), {key:'ArrowDown'});
  expect(option.getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(screen.getByRole('combobox'), {key:'Enter'});
  expect(onOpenPlugin).toHaveBeenCalledWith('install-1');
});
it('opens the management dialogs from keyboard actions', () => {
  const onManagePlugins = vi.fn();
  render(<CommandPalette {...props} onManagePlugins={onManagePlugins} />);
  fireEvent.change(screen.getByRole('combobox'), {target:{value:'Manage plugins'}});
  const option = screen.getByRole('option', {name:'Manage plugins'});
  fireEvent.keyDown(screen.getByRole('combobox'), {key:'ArrowDown'});
  expect(option.getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(screen.getByRole('combobox'), {key:'Enter'});
  expect(onManagePlugins).toHaveBeenCalledOnce();
});
it('hands a query to the assistant with ⌘↵ and opens the files it cites', async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/assistant')) {
      expect(JSON.parse(String(init?.body))).toEqual({ messages: [{ role: 'user', content: 'when does the lease end?' }] });
      return new Response(JSON.stringify({ answer: 'The lease ends on 31 March 2027.', sources: [{ space: 'family', fileId: 'lease', name: 'Lease.pdf' }] }));
    }
    return new Response(JSON.stringify({ hits: [] }));
  });
  vi.stubGlobal('fetch', fetch);
  const onOpenFile = vi.fn();
  render(<CommandPalette {...props} onOpenFile={onOpenFile} sites={[{ slug: 'family', name: 'Family', current: true } as never]} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'when does the lease end?' } });
  expect(screen.getByRole('option', { name: /Ask the assistant: “when does the lease end\?”/ })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', metaKey: true });
  expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('');
  expect(screen.getByRole('status').textContent).toBe('Searching your documents…');
  await screen.findByText('The lease ends on 31 March 2027.');
  fireEvent.click(screen.getByRole('button', { name: /Lease\.pdf/ }));
  expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'lease', name: 'Lease.pdf' }));
});
it('sends the whole conversation with a follow-up, and keeps it across close and reopen', async () => {
  const bodies: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ answer: `Answer ${bodies.length}`, sources: [] }));
  }));
  const view = render(<CommandPalette {...props} />);
  fireEvent.click(screen.getByRole('option', { name: /Ask the assistant…/ }));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'first' } });
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  await screen.findByText('Answer 1');
  view.rerender(<CommandPalette {...props} open={false} />);
  view.rerender(<CommandPalette {...props} />);
  fireEvent.click(screen.getByRole('option', { name: /Continue the conversation/ }));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'second' } });
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  await screen.findByText('Answer 2');
  expect(bodies[1]).toEqual({ messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'Answer 1' }, { role: 'user', content: 'second' }] });
});
it('shows an assistant failure with a retry instead of a blank answer', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'The assistant is not available on this install.' }), { status: 503 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ answer: 'Now it works.', sources: [] }))));
  render(<CommandPalette {...props} />);
  fireEvent.click(screen.getByRole('option', { name: /Ask the assistant…/ }));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'hello' } });
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  expect((await screen.findByRole('alert')).textContent).toBe('The assistant is not available on this install.');
  fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
  await screen.findByText('Now it works.');
});
it('offers no assistant while offline', () => {
  render(<CommandPalette {...props} offline />);
  expect(screen.queryByRole('option', { name: /Ask the assistant/ })).toBeNull();
});
it('replaces a question whose answer failed instead of sending two in a row', async () => {
  const bodies: { messages: { role: string }[] }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1
      ? new Response(JSON.stringify({ detail: 'The assistant could not answer just now.' }), { status: 502 })
      : new Response(JSON.stringify({ answer: 'Answered.', sources: [] }));
  }));
  render(<CommandPalette {...props} />);
  fireEvent.click(screen.getByRole('option', { name: /Ask the assistant…/ }));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'first' } });
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  await screen.findByRole('alert');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'second' } });
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  await screen.findByText('Answered.');
  expect(bodies[1]).toEqual({ messages: [{ role: 'user', content: 'second' }] });
  expect(screen.queryByText('first')).toBeNull();
});
it('opens a source in another space through the guarded space switch', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ answer: 'See it.', sources: [{ space: 'work', fileId: 'inv', name: 'Invoice.pdf' }] }))));
  const onOpenFile = vi.fn();
  render(<CommandPalette {...props} onOpenFile={onOpenFile} />);
  fireEvent.click(screen.getByRole('option', { name: /Ask the assistant…/ }));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'invoice' } });
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  fireEvent.click(await screen.findByRole('button', { name: /Invoice\.pdf/ }));
  // No current space known: never by id in the wrong space, always by switching.
  expect(onOpenFile).not.toHaveBeenCalled();
  expect(openSpaceFile).toHaveBeenCalledWith('work', 'inv');
});
it('does not send while an IME is composing', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  render(<CommandPalette {...props} />);
  fireEvent.click(screen.getByRole('option', { name: /Ask the assistant…/ }));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'けいやく' } });
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', isComposing: true });
  expect(fetch).not.toHaveBeenCalled();
  expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('けいやく');
});
it('starts a new conversation when asked from search, and continues one only when asked to', async () => {
  const bodies: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ answer: `Answer ${bodies.length}`, sources: [] }));
  }));
  const view = render(<CommandPalette {...props} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'invoices' } });
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', metaKey: true });
  await screen.findByText('Answer 1');
  view.rerender(<CommandPalette {...props} open={false} />);
  view.rerender(<CommandPalette {...props} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'lease end' } });
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', metaKey: true });
  await screen.findByText('Answer 2');
  expect(bodies[1]).toEqual({ messages: [{ role: 'user', content: 'lease end' }] });
  expect(screen.queryByText('Answer 1')).toBeNull();
});
