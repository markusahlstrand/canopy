import { expect, it } from 'vitest';
import { effectivePlugins, installedPluginMatchesSearch, matchingPlugins, pluginManifest } from './installed-plugins';
import { pluginDocument } from './sandbox-plugin';
import type { PluginInstall } from './api';
const plugin = (id: string, principal: string, enabled = 1): PluginInstall => ({id, principal, enabled, plugin_id: 'markdown', source: '', updated_at: 'revision', manifest_json: JSON.stringify({id:'markdown',name:'Markdown',version:'1', capabilities:[{kind:'item:read'}],contributes:{viewers:[{id:'md',match:['.md','text/markdown']}]}})});
const viewer = (match: string[], description = '', principal = 'user'): PluginInstall => ({id: 'viewer', principal, enabled: 1, plugin_id: 'viewer', source: '', updated_at: 'revision', manifest_json: JSON.stringify({id:'viewer',name:'Viewer',version:'1',description,capabilities:[{kind:'item:read'}],contributes:{viewers:[{id:'v',match}]}})});
it('uses personal overrides, including disabled installs, and matches case-insensitive extensions', () => {
  expect(effectivePlugins([plugin('shared','space'),plugin('mine','user')]).map(row => row.id)).toEqual(['mine']);
  expect(matchingPlugins([plugin('shared','space'),plugin('mine','user')], 'text/plain', 'README.MD').map(row => row.id)).toEqual(['mine']);
  expect(matchingPlugins([plugin('shared','space'),plugin('mine','user',0)], 'text/markdown', 'readme.md')).toEqual([]);
  expect(matchingPlugins([plugin('shared','space')], 'text/plain', 'readme.txt')).toEqual([]);
});
it('finds installed plugins by viewer file type and scope', () => {
  expect(installedPluginMatchesSearch(plugin('shared', 'space'), '.MD')).toBe(true);
  expect(installedPluginMatchesSearch(plugin('shared', 'space'), 'space')).toBe(true);
  expect(installedPluginMatchesSearch(plugin('mine', 'user'), 'personal')).toBe(true);
  expect(installedPluginMatchesSearch(plugin('mine', 'user'), '.pdf')).toBe(false);
});
it('matches file-type searches with the same rules used to open files', () => {
  expect(installedPluginMatchesSearch(viewer(['image/*']), 'image/png')).toBe(true);
  expect(installedPluginMatchesSearch(viewer(['.png']), 'photo.png')).toBe(true);
  expect(installedPluginMatchesSearch(viewer(['.text']), '.tex')).toBe(false);
  expect(installedPluginMatchesSearch(plugin('mine', 'user'), 'notes.md')).toBe(true);
  expect(installedPluginMatchesSearch(plugin('mine', 'user'), 'text/markdown; charset=utf-8')).toBe(true);
});
it('treats scope keywords as a filter on where the plugin is installed', () => {
  const personal = viewer(['.md'], 'Notes shared with your space');
  expect(installedPluginMatchesSearch(personal, 'space')).toBe(false);
  expect(installedPluginMatchesSearch(personal, 'you')).toBe(true);
  expect(installedPluginMatchesSearch(personal, 'mine')).toBe(true);
  expect(installedPluginMatchesSearch(viewer(['.md'], '', 'space'), 'personal')).toBe(false);
});
it('restricts iframe resources to validated declared HTTPS hosts', () => {
  const document = pluginDocument(['esm.sh', 'bad\"; script-src *']);
  expect(document).toContain("default-src 'none'");
  expect(document).toContain('https://esm.sh');
  expect(document).not.toContain('bad');
  expect(pluginDocument()).toContain("connect-src 'none'");
});
it('keeps a damaged install visible for repair without registering its contributions', () => {
  const damaged = { ...plugin('damaged', 'user'), manifest_json: '{broken' };
  expect(pluginManifest(damaged).invalid).toBe(true);
  expect(matchingPlugins([damaged], 'text/markdown', 'readme.md')).toEqual([]);
  expect(matchingPlugins([plugin('shared', 'space'), damaged], 'text/markdown', 'readme.md').map(row => row.id)).toEqual(['shared']);
  expect(installedPluginMatchesSearch(damaged, 'markdown')).toBe(true);
});
it('preserves legacy installs whose manifest predates id and version fields', () => {
  const legacy = { ...plugin('legacy', 'user'), manifest_json: JSON.stringify({ name: 'Legacy viewer', capabilities: [{ kind: 'item:read' }], contributes: { viewers: [{ id: 'md', match: ['.md'] }] } }) };
  expect(pluginManifest(legacy).name).toBe('Legacy viewer');
  expect(matchingPlugins([legacy], 'text/plain', 'readme.md')).toEqual([legacy]);
});
it('reuses parsed manifests until a row changes', () => {
  const row = plugin('mine', 'user');
  const first = pluginManifest(row);
  expect(pluginManifest(row)).toBe(first);
  row.manifest_json = JSON.stringify({ ...first, name: 'Updated viewer' });
  expect(pluginManifest(row).name).toBe('Updated viewer');
});
