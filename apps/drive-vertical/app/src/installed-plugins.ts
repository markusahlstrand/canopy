import { useSyncExternalStore } from 'react';
import { listPlugins, type PluginInstall } from './api';
import { isFileTypeQuery, viewerMatchesSearch } from './plugin-search';
export interface PluginManifest {
  id: string; name: string; version: string; description?: string;
  invalid?: boolean;
  capabilities: { kind: string; hosts?: string[] }[];
  contributes: { viewers?: { id: string; title?: string; match: string[]; fill?: boolean }[]; detailView?: { id: string; title: string } };
}
let rows: PluginInstall[] = [];
const listeners = new Set<() => void>();
let latest = 0;
export function publishPlugins(plugins: PluginInstall[]) { rows = plugins; listeners.forEach(listener => listener()); }
export async function refreshPlugins() { const ticket = ++latest; const result = await listPlugins(); if (!Array.isArray(result.plugins)) throw new Error("Invalid plugin response"); if (ticket === latest) publishPlugins(result.plugins); }
export const useInstalledPlugins = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => rows);
export function pluginManifest(row: PluginInstall): PluginManifest {
  try {
    const value: unknown = JSON.parse(row.manifest_json);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const manifest = value as Record<string, unknown>;
      const contributes = manifest.contributes as Record<string, unknown> | undefined;
      if (typeof manifest.name === 'string'
        && (manifest.description === undefined || typeof manifest.description === 'string')
        && Array.isArray(manifest.capabilities) && manifest.capabilities.every(cap => cap && typeof cap.kind === 'string')
        && contributes && typeof contributes === 'object' && !Array.isArray(contributes)
        && (!contributes.viewers || Array.isArray(contributes.viewers) && contributes.viewers.every(viewer => viewer && (viewer.title === undefined || typeof viewer.title === 'string') && Array.isArray(viewer.match) && viewer.match.every((match: unknown) => typeof match === 'string')))
        && (!contributes.detailView || typeof contributes.detailView === 'object' && typeof (contributes.detailView as Record<string, unknown>).title === 'string'))
        return { ...manifest, id: typeof manifest.id === 'string' ? manifest.id : row.plugin_id, version: typeof manifest.version === 'string' ? manifest.version : '' } as PluginManifest;
    }
  } catch { /* A damaged install still needs to be removable from the UI. */ }
  return { id: row.plugin_id, name: `Invalid manifest: ${row.plugin_id}`, version: '', capabilities: [], contributes: {}, invalid: true };
}
const scopeKeywords: Record<string, 'space' | 'personal'> = {space: 'space', personal: 'personal', you: 'personal', mine: 'personal'};
/** Search the installed contribution, including the file types and app title users know it by. */
export function installedPluginMatchesSearch(row: PluginInstall, query: string): boolean {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return true;
  const scope = scopeKeywords[term];
  if (scope) return (row.principal === 'space') === (scope === 'space');
  const manifest = pluginManifest(row);
  const viewers = manifest.contributes.viewers ?? [];
  if (isFileTypeQuery(term)) return viewers.some(viewer => viewerMatchesSearch(viewer.match, term));
  const searchable = [
    manifest.name, row.plugin_id, manifest.description ?? '',
    ...manifest.capabilities.map(capability => capability.kind),
    ...viewers.flatMap(viewer => [viewer.title ?? '', ...viewer.match]),
    manifest.contributes.detailView?.title ?? '',
  ];
  return searchable.some(value => value.toLocaleLowerCase().includes(term));
}
/** Personal installs override the same plugin applied to a space. */
export function effectivePlugins(rows: PluginInstall[]): PluginInstall[] {
  const effective = new Map<string, PluginInstall>();
  for (const row of [...rows.filter(row => row.principal === 'space'), ...rows.filter(row => row.principal !== 'space')]) {
    if (!pluginManifest(row).invalid) effective.set(row.plugin_id, row);
  }
  return [...effective.values()];
}
export function matchingPlugins(rows: PluginInstall[], mime: string, name: string): PluginInstall[] {
  return effectivePlugins(rows).filter(row => row.enabled === 1 && pluginManifest(row).capabilities.some(cap => cap.kind === 'item:read') && pluginManifest(row).contributes.viewers?.some(viewer => viewer.match.some(match => {
    const pattern = match.toLowerCase(); const type = mime.split(';')[0]!.trim().toLowerCase();
    return pattern.startsWith('.') ? name.toLowerCase().endsWith(pattern) : pattern.endsWith('/*') ? type.startsWith(pattern.slice(0, -1)) : pattern === type;
  })));
}
