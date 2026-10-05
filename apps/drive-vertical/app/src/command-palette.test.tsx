import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CommandPalette } from './command-palette';
import type { PluginInstall } from './api';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const props = { open: true, onOpenChange: vi.fn(), files: [], onNavigate: vi.fn(), onOpenFile: vi.fn(), onUpload: vi.fn() };
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
