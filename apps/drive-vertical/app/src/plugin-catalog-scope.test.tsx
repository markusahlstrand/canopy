import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PluginManagement } from './plugin-management';
import { pluginCatalog } from './plugin-catalog';
import { publishPlugins } from './installed-plugins';
import type { PluginInstall } from './api';

afterEach(() => { cleanup(); publishPlugins([]); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('requires fresh approval when the reviewed plugin, source, capabilities or install audience changes', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(url.endsWith('/people/access') ? { canManage: true } : { plugins: [] })));
  render(<PluginManagement open onOpenChange={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Review Image Viewer' }));
  const approve = () => fireEvent.click(screen.getByRole('checkbox', { name: /Approve the capabilities/ }));
  const refused = () => {
    expect((screen.getByRole('checkbox', { name: /Approve the capabilities/ }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('button', { name: 'Install plugin' }) as HTMLButtonElement).disabled).toBe(true);
  };
  approve();
  expect((screen.getByRole('button', { name: 'Install plugin' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Review Image Viewer' }));
  refused();
  approve();
  fireEvent.click(screen.getByRole('button', { name: 'Review PDF Viewer' }));
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
  fireEvent.click(screen.getByRole('checkbox', { name: 'Apply to this space' }));
  refused();
});

it('shows where a catalog plugin is installed and opens review for this space', async () => {
  const manifest = pluginCatalog[1]!.manifest;
  const row = (id: string, principal: string): PluginInstall => ({
    id, principal, plugin_id: manifest.id, manifest_json: JSON.stringify(manifest), source: '',
    enabled: 1, updated_at: 'revision', source_kind: 'bundled', source_ref: '', resolved: '', source_sha256: '', granted_capabilities: '[]',
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith('/people/access') ? { canManage: true } : { plugins: [row('mine', 'person'), row('ours', 'space')] },
  ))));
  render(<PluginManagement open onOpenChange={() => {}} />);
  const action = await screen.findByRole('button', { name: `Apply ${manifest.name} to space` });
  expect(screen.getByText('Enabled for you')).toBeTruthy();
  expect(screen.getByText('Enabled in this space')).toBeTruthy();
  fireEvent.click(action);
  expect((screen.getByRole('checkbox', { name: 'Apply to this space' }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('Plugin manifest') as HTMLTextAreaElement).value).toContain(manifest.id);
});
