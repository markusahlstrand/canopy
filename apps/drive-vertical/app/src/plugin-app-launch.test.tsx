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
