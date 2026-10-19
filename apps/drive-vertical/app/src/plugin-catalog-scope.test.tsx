import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PluginManagement } from './plugin-management';
import { pluginCatalog } from './plugin-catalog';
import { publishPlugins } from './installed-plugins';
import type { PluginInstall } from './api';

afterEach(() => { cleanup(); publishPlugins([]); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('requires fresh approval when the reviewed plugin, source, capabilities or install audience changes', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(url.endsWith('/people/access') ? { canManage: true } : { plugins: [] })));
  render(<PluginManagement open onOpenChange={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'View Image Viewer source' }));
  const approve = () => fireEvent.click(screen.getByRole('checkbox', { name: /Approve the capabilities/ }));
  const refused = () => {
    expect((screen.getByRole('checkbox', { name: /Approve the capabilities/ }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('button', { name: 'Install plugin' }) as HTMLButtonElement).disabled).toBe(true);
  };
  approve();
  expect((screen.getByRole('button', { name: 'Install plugin' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'View Image Viewer source' }));
  refused();
  approve();
  fireEvent.click(screen.getByRole('button', { name: 'View PDF Viewer source' }));
  refused();
  approve();
  const manifest = screen.getByLabelText('Plugin manifest') as HTMLTextAreaElement;
  const changed = JSON.parse(manifest.value);
  changed.capabilities.push({ kind: 'item:write' });
  fireEvent.change(manifest, { target: { value: JSON.stringify(changed) } });
  refused();
  approve();
  fireEvent.change(screen.getByLabelText('Plugin source'), { target: { value: 'export default function render() {}' } });
  refused();
  approve();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Install for everyone in this space' }));
  refused();
});

it('shows where a catalog plugin is installed and hides installs it already has', async () => {
  const manifest = pluginCatalog[1]!.manifest;
  const row = (id: string, principal: string): PluginInstall => ({
    id, principal, plugin_id: manifest.id, manifest_json: JSON.stringify(manifest), source: '',
    enabled: 1, updated_at: 'revision', source_kind: 'bundled', source_ref: '', resolved: '', source_sha256: '', granted_capabilities: '[]',
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith('/people/access') ? { canManage: true } : { plugins: [row('mine', 'person'), row('ours', 'space')] },
  ))));
  render(<PluginManagement open onOpenChange={() => {}} />);
  expect(await screen.findByText('Enabled for you')).toBeTruthy();
  expect(screen.getByText('Enabled in this space')).toBeTruthy();
  const card = screen.getByRole('region', { name: manifest.name });
  expect(within(card).queryByRole('button', { name: 'Install' })).toBeNull();
  expect(within(card).queryByRole('button', { name: 'Install for everyone in this space' })).toBeNull();
});

it('installs a catalog plugin for the space straight from its card after confirming its access', async () => {
  const manifest = pluginCatalog.find(entry => entry.manifest.id === 'locked-notes')!.manifest;
  const posts: { url: string; body: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') posts.push({ url, body: String(init.body) });
    return new Response(JSON.stringify(url.endsWith('/people/access') ? { canManage: true } : { plugins: [] }));
  }));
  render(<PluginManagement open onOpenChange={() => {}} spaceName="substrat" />);
  await screen.findAllByRole('button', { name: 'Install for everyone in substrat' });
  const card = screen.getByRole('region', { name: manifest.name });
  fireEvent.click(within(card).getByRole('button', { name: 'Install for everyone in substrat' }));
  const confirm = within(card).getByRole('group', { name: `Confirm ${manifest.name}` });
  expect(within(confirm).getByText('Read the file you open with it')).toBeTruthy();
  expect(within(confirm).getByText('Save changes to that file')).toBeTruthy();
  expect(posts).toHaveLength(0);
  fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm install' }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]!.body).toContain('"locked-notes"');
  await waitFor(() => expect(within(card).queryByRole('group', { name: `Confirm ${manifest.name}` })).toBeNull());
});

it('offers no catalog install until the installed list loads, and drops a confirmation the list makes stale', async () => {
  const manifest = pluginCatalog.find(entry => entry.manifest.id === 'locked-notes')!.manifest;
  const installed: PluginInstall = {
    id: 'mine', principal: 'person', plugin_id: manifest.id, manifest_json: JSON.stringify(manifest), source: 'edited',
    enabled: 1, updated_at: 'revision', source_kind: 'bundled', source_ref: '', resolved: '', source_sha256: '', granted_capabilities: '[]',
  };
  let release!: (plugins: PluginInstall[]) => void;
  const list = new Promise<PluginInstall[]>(resolve => { release = resolve; });
  const writes = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') writes(url);
    if (url.endsWith('/people/access')) return new Response(JSON.stringify({ canManage: true }));
    return new Response(JSON.stringify({ plugins: await list }));
  }));
  render(<PluginManagement open onOpenChange={() => {}} />);
  const card = screen.getByRole('region', { name: manifest.name });
  expect(within(card).queryByRole('button', { name: 'Install' })).toBeNull();
  release([installed]);
  await screen.findByText('Enabled for you');
  expect(within(card).queryByRole('button', { name: 'Install' })).toBeNull();
  expect(within(card).queryByRole('group', { name: `Confirm ${manifest.name}` })).toBeNull();
  expect(writes).not.toHaveBeenCalled();
});

it('forgets a pending catalog confirmation when the dialog closes', async () => {
  const manifest = pluginCatalog.find(entry => entry.manifest.id === 'locked-notes')!.manifest;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/people/access') ? { canManage: true } : { plugins: [] }))));
  const view = render(<PluginManagement open onOpenChange={() => {}} />);
  const card = () => screen.getByRole('region', { name: manifest.name });
  fireEvent.click(await within(card()).findByRole('button', { name: 'Install for everyone in this space' }));
  expect(within(card()).getByRole('group', { name: `Confirm ${manifest.name}` })).toBeTruthy();
  view.rerender(<PluginManagement open={false} onOpenChange={() => {}} />);
  view.rerender(<PluginManagement open onOpenChange={() => {}} />);
  await screen.findByRole('region', { name: manifest.name });
  await within(card()).findByRole('button', { name: 'Install for everyone in this space' });
  expect(within(card()).queryByRole('group', { name: `Confirm ${manifest.name}` })).toBeNull();
});
