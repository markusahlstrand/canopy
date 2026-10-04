import { useSyncExternalStore } from 'react';
import { listPlugins, type PluginInstall } from './api';
export interface PluginManifest {
  id: string; name: string; version: string; description?: string;
  capabilities: { kind: string; hosts?: string[] }[];
  contributes: { viewers?: { id: string; title?: string; match: string[]; fill?: boolean }[]; detailView?: { id: string; title: string } };
}
let rows: PluginInstall[] = [];
const listeners = new Set<() => void>();
let latest = 0;
export function publishPlugins(plugins: PluginInstall[]) { rows = plugins; listeners.forEach(listener => listener()); }
export async function refreshPlugins() { const ticket = ++latest; const result = await listPlugins(); if (!Array.isArray(result.plugins)) throw new Error("Invalid plugin response"); if (ticket === latest) publishPlugins(result.plugins); }
export const useInstalledPlugins = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => rows);
export function pluginManifest(row: PluginInstall): PluginManifest { return JSON.parse(row.manifest_json) as PluginManifest; }
/** Personal installs override the same plugin applied to a space. */
export function effectivePlugins(rows: PluginInstall[]): PluginInstall[] {
  const effective = new Map<string, PluginInstall>();
  for (const row of [...rows.filter(row => row.principal === 'space'), ...rows.filter(row => row.principal !== 'space')]) effective.set(row.plugin_id, row);
  return [...effective.values()];
}
export function matchingPlugins(rows: PluginInstall[], mime: string, name: string): PluginInstall[] {
  return effectivePlugins(rows).filter(row => row.enabled === 1 && pluginManifest(row).capabilities.some(cap => cap.kind === 'item:read') && pluginManifest(row).contributes.viewers?.some(viewer => viewer.match.some(match => {
    const pattern = match.toLowerCase(); const type = mime.split(';')[0]!.trim().toLowerCase();
    return pattern.startsWith('.') ? name.toLowerCase().endsWith(pattern) : pattern.endsWith('/*') ? type.startsWith(pattern.slice(0, -1)) : pattern === type;
  })));
}
