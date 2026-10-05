import { expect, it } from 'vitest';
import { effectivePlugins, installedPluginMatchesSearch, matchingPlugins } from './installed-plugins';
import { pluginDocument } from './sandbox-plugin';
import type { PluginInstall } from './api';
const plugin = (id: string, principal: string, enabled = 1): PluginInstall => ({id, principal, enabled, plugin_id: 'markdown', source: '', updated_at: 'revision', manifest_json: JSON.stringify({id:'markdown',name:'Markdown',version:'1', capabilities:[{kind:'item:read'}],contributes:{viewers:[{id:'md',match:['.md','text/markdown']}]}})});
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
it('restricts iframe resources to validated declared HTTPS hosts', () => {
  const document = pluginDocument(['esm.sh', 'bad\"; script-src *']);
  expect(document).toContain("default-src 'none'");
  expect(document).toContain('https://esm.sh');
  expect(document).not.toContain('bad');
  expect(pluginDocument()).toContain("connect-src 'none'");
});
