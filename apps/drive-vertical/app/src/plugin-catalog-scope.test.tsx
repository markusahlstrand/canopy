import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PluginManagement } from './plugin-management';
import { pluginCatalog } from './plugin-catalog';
import { publishPlugins } from './installed-plugins';
import type { PluginInstall } from './api';

afterEach(() => { cleanup(); publishPlugins([]); vi.unstubAllGlobals(); });

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
  expect(screen.getByText('For you')).toBeTruthy();
  expect(screen.getByText('For this space')).toBeTruthy();
  fireEvent.click(action);
  expect((screen.getByRole('checkbox', { name: 'Apply to this space' }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('Plugin manifest') as HTMLTextAreaElement).value).toContain(manifest.id);
});
