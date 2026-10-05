import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PluginManagement } from './plugin-management';
import { publishPlugins } from './installed-plugins';

afterEach(() => { cleanup(); publishPlugins([]); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('opens an installed app in the drive view and closes the Plugins dialog', async () => {
  const manifest = { id: 'sample-app', name: 'Sample App', version: '1', capabilities: [], contributes: { detailView: { id: 'main', title: 'Sample App' } } };
  const app = { id: 'install', plugin_id: manifest.id, principal: 'space', manifest_json: JSON.stringify(manifest), enabled: 1,
    updated_at: 'revision', source_kind: 'inline', source_ref: '', resolved: '', source_sha256: '', granted_capabilities: '[]' };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith('/people/access') ? { canManage: false } : { plugins: [app] },
  ))));
  const onOpenChange = vi.fn(), onOpenApp = vi.fn();
  render(<PluginManagement open onOpenChange={onOpenChange} onOpenApp={onOpenApp} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open app' }));
  expect(onOpenApp).toHaveBeenCalledWith('install');
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(screen.queryByTitle('Sample App')).toBeNull();
});

it('offers launch only for the effective personal install when a space copy is shadowed', async () => {
  const manifest = { id: 'sample-app', name: 'Sample App', version: '1', capabilities: [], contributes: { detailView: { id: 'main', title: 'Sample App' } } };
  const space = { id: 'space-install', plugin_id: manifest.id, principal: 'space', manifest_json: JSON.stringify(manifest), enabled: 1,
    updated_at: 'revision', source_kind: 'inline', source_ref: '', resolved: '', source_sha256: '', granted_capabilities: '[]' };
  const personal = { ...space, id: 'personal-install', principal: 'person' };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith('/people/access') ? { canManage: false } : { plugins: [space, personal] },
  ))));
  const onOpenApp = vi.fn();
  render(<PluginManagement open onOpenChange={() => {}} onOpenApp={onOpenApp} />);
  expect(await screen.findAllByRole('button', { name: 'Open app' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Open app' }));
  expect(onOpenApp).toHaveBeenCalledWith('personal-install');
});

it('does not offer launch when a disabled personal install shadows an enabled space copy', async () => {
  const manifest = { id: 'sample-app', name: 'Sample App', version: '1', capabilities: [], contributes: { detailView: { id: 'main', title: 'Sample App' } } };
  const space = { id: 'space-install', plugin_id: manifest.id, principal: 'space', manifest_json: JSON.stringify(manifest), enabled: 1,
    updated_at: 'revision', source_kind: 'inline', source_ref: '', resolved: '', source_sha256: '', granted_capabilities: '[]' };
  const personal = { ...space, id: 'personal-install', principal: 'person', enabled: 0 };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith('/people/access') ? { canManage: false } : { plugins: [space, personal] },
  ))));
  render(<PluginManagement open onOpenChange={() => {}} onOpenApp={() => {}} />);
  await screen.findByText('Installed for you');
  expect(screen.queryByRole('button', { name: 'Open app' })).toBeNull();
});
