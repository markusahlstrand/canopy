import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button, Input, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@canopy/ui';
import { setImageViewerEnabled, viewerRegistry } from './image-viewer';
import { peopleAccess, savePlugin, togglePlugin, removePlugin } from './api';
import { pluginCatalog } from './plugin-catalog';
import { SandboxPlugin } from './sandbox-plugin';
import { useUnsavedDraft, confirmDiscardDrafts } from './drafts';
import type { PluginInstall } from './api';
import { refreshPlugins, useInstalledPlugins, pluginManifest } from './installed-plugins';
/** Manage installed viewer contributions; available plugins are reviewed and bundled. */
export function PluginManagement({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  useSyncExternalStore(viewerRegistry.subscribe, viewerRegistry.snapshot);
  const [studioOpen, setStudioOpen] = useState(false);
  const [editingInstall, setEditingInstall] = useState<PluginInstall | null>(null);
  const [app, setApp] = useState<PluginInstall | null>(null);
  const plugins = useInstalledPlugins();
  const [manifest, setManifest] = useState('');
  const [source, setSource] = useState('');
  useUnsavedDraft(open && (!!manifest || !!source));
  const [forSpace, setForSpace] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!open) return; let alive = true; refreshPlugins().catch(() => { if (alive) setError('Could not load installed plugins.'); }); peopleAccess().then(result => { if (alive) setCanManage(result.canManage); }).catch(() => {}); return () => { alive = false; }; }, [open]);
  const change = async (action: () => Promise<unknown>) => { setBusy(true); setError(null); try { await action(); await refreshPlugins(); } catch (error) { setError(error instanceof Error ? error.message || 'Could not update this plugin.' : String(error)); } finally { setBusy(false); } };
  const [query, setQuery] = useState('');
  const enabled = viewerRegistry.has('image-viewer');
  const installed = viewerRegistry.list();
  return <Dialog open={open} onOpenChange={next => { if (!next && !confirmDiscardDrafts()) return; onOpenChange(next); }}><DialogContent className="max-h-[85vh] overflow-auto">
    <DialogHeader><DialogTitle>Plugins</DialogTitle><DialogDescription>Install file viewers for yourself or apply them to the current space. Review the access requested by each plugin before installing.</DialogDescription></DialogHeader>
    <Input aria-label="Find a plugin" placeholder="Find a plugin" value={query} onChange={event => setQuery(event.target.value)} />
    {error ? <p role="alert">{error}</p> : null}
    <h3 className="font-medium">Your plugins</h3>
    {plugins.filter(row => `${pluginManifest(row).name} ${row.plugin_id}`.toLowerCase().includes(query.toLowerCase())).map(row => <section key={row.id} className="rounded border p-3">
      <h4>{pluginManifest(row).name}</h4><p>{row.principal === 'space' ? 'Applied to this space' : 'Installed for you'} · {row.enabled ? 'Enabled' : 'Disabled'}</p>
      <p className="text-xs">Access: {pluginManifest(row).capabilities.map(cap => cap.kind === 'net:fetch' ? `Network: ${cap.hosts?.join(', ')}` : cap.kind).join(', ') || 'None'}</p>
      <Button disabled={busy || (row.principal === 'space' && !canManage)} onClick={() => void change(() => togglePlugin(row.id, !row.enabled))}>{row.enabled ? 'Disable' : 'Enable'}</Button>
      <Button variant="outline" disabled={busy || (row.principal === 'space' && !canManage)} onClick={() => { if (!confirmDiscardDrafts()) return; setEditingInstall(row); setManifest(JSON.stringify(pluginManifest(row), null, 2)); setSource(row.source); setForSpace(row.principal === 'space'); setStudioOpen(true); }}>Edit source</Button>
      {row.enabled && pluginManifest(row).contributes.detailView ? <Button onClick={() => setApp(row)}>Open app</Button> : null}
      <Button variant="outline" disabled={busy || (row.principal === 'space' && !canManage)} onClick={() => { if (window.confirm(`Remove ${pluginManifest(row).name}?`)) void change(() => removePlugin(row.id)); }}>Remove</Button>
    </section>)}
    {app ? <section><Button variant="outline" onClick={() => setApp(null)}>Close app</Button><SandboxPlugin key={app.id} plugin={app} /></section> : null}
    <Button variant="outline" onClick={() => { if (!confirmDiscardDrafts()) return; setEditingInstall(null); setManifest(JSON.stringify({id:'my-plugin',name:'My plugin',version:'0.1.0',capabilities:[{kind:'item:read'}],contributes:{viewers:[{id:'text',title:'Text',match:['text/*']}]}}, null, 2)); setSource('export default function render({container, file}) {\n  container.textContent = new TextDecoder().decode(file.bytes);\n}\n'); setForSpace(false); setStudioOpen(true); }}>Build a plugin</Button>
    <details open={studioOpen} onToggle={event => setStudioOpen(event.currentTarget.open)}><summary>Plugin Studio · import or edit source</summary><p className="text-sm">Paste canopy.json and its JavaScript entry source. Imported code runs in a sandbox with access only to the opened file and the declared network hosts.</p>
      <label>Plugin manifest<textarea className="w-full rounded border p-2" aria-label="Plugin manifest" value={manifest} onChange={event => setManifest(event.target.value)} /></label>
      <label>Plugin source<textarea className="w-full rounded border p-2" aria-label="Plugin source" value={source} onChange={event => setSource(event.target.value)} /></label>
      {canManage ? <label><input type="checkbox" checked={forSpace} onChange={event => setForSpace(event.target.checked)} />Apply to this space</label> : null}
      <Button disabled={busy || !manifest || !source} onClick={() => void change(async () => { const parsed = JSON.parse(manifest) as {id: string}; const previous = plugins.find(row => row.plugin_id === parsed.id && (row.principal === 'space') === forSpace); if (previous && !window.confirm('Replace this installed plugin and its source?')) return; const revision = editingInstall?.plugin_id === parsed.id && (editingInstall.principal === 'space') === forSpace ? editingInstall.updated_at : previous?.updated_at ?? null; await savePlugin(parsed, source, revision, forSpace); setEditingInstall(null); setManifest(''); setSource(''); })}>Install plugin</Button>
    </details>
    <h3 className="font-medium">Available plugins</h3>
    {pluginCatalog.filter(entry => `${entry.manifest.name} ${entry.manifest.description}`.toLowerCase().includes(query.toLowerCase())).map(entry => <section key={entry.manifest.id} className="rounded border p-3"><h4>{entry.manifest.name}</h4><p className="text-sm">{entry.manifest.description}</p><p className="text-xs">Access: {entry.manifest.capabilities.map(cap => cap.kind === 'net:fetch' ? `Network: ${cap.hosts?.join(', ')}` : cap.kind).join(', ')}. Network access is limited to these declared library hosts; editors can fall back to plain text offline.</p><Button disabled={busy} onClick={() => { if (!confirmDiscardDrafts()) return; setEditingInstall(null); setManifest(JSON.stringify(entry.manifest, null, 2)); setSource(entry.source); setForSpace(false); setStudioOpen(true); }}>Review {entry.manifest.name}</Button></section>)}
    {'image viewer'.includes(query.toLowerCase()) ? <section aria-label="Image viewer" className="space-y-2 rounded border p-3">
      <h4 className="font-medium">Image viewer</h4><p className="text-sm">Preview images with zoom and keyboard controls.</p>
      <p className="text-xs text-muted-foreground">Bundled with Canopy · Reads the file you open · No editing</p>
      <p role="status">{enabled ? 'Enabled' : 'Disabled'}</p>
      <Button size="sm" variant="outline" onClick={() => setImageViewerEnabled(!enabled)}>{enabled ? 'Disable image viewer' : 'Enable image viewer'}</Button>
    </section> : <p>No available plugins match this search.</p>}
    <h3 className="font-medium">Active file viewers</h3>
    {installed.length ? <ul className="space-y-2">{installed.filter(plugin => `${plugin.pluginId} ${plugin.id}`.toLowerCase().includes(query.toLowerCase())).map(plugin => <li key={`${plugin.pluginId}:${plugin.id}`} className="rounded border p-2">
      <p>{plugin.pluginId} / {plugin.id}</p><p className="text-xs text-muted-foreground">Handles: {plugin.match.join(', ')}</p>
    </li>)}</ul> : <p>No optional viewers are enabled.</p>}
    <p className="text-xs text-muted-foreground">Preferences apply to this browser, including its other open tabs.</p>
  </DialogContent></Dialog>;
}
