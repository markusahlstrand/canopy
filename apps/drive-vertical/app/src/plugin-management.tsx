import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button, Input, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@canopy/ui';
import { setImageViewerEnabled, viewerRegistry } from './image-viewer';
import { peopleAccess, savePlugin, togglePlugin, removePlugin } from './api';
import { refreshPlugins, useInstalledPlugins, pluginManifest } from './installed-plugins';
/** Manage installed viewer contributions; available plugins are reviewed and bundled. */
export function PluginManagement({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  useSyncExternalStore(viewerRegistry.subscribe, viewerRegistry.snapshot);
  const plugins = useInstalledPlugins();
  const [manifest, setManifest] = useState('');
  const [source, setSource] = useState('');
  const [forSpace, setForSpace] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!open) return; let alive = true; refreshPlugins().catch(() => { if (alive) setError('Could not load installed plugins.'); }); peopleAccess().then(result => { if (alive) setCanManage(result.canManage); }).catch(() => {}); return () => { alive = false; }; }, [open]);
  const change = async (action: () => Promise<unknown>) => { setBusy(true); setError(null); try { await action(); await refreshPlugins(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  const [query, setQuery] = useState('');
  const enabled = viewerRegistry.has('image-viewer');
  const installed = viewerRegistry.list();
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[85vh] overflow-auto">
    <DialogHeader><DialogTitle>Plugins</DialogTitle><DialogDescription>Install file viewers for yourself or apply them to the current space. Review the access requested by each plugin before installing.</DialogDescription></DialogHeader>
    <Input aria-label="Find a plugin" placeholder="Find a plugin" value={query} onChange={event => setQuery(event.target.value)} />
    {error ? <p role="alert">{error}</p> : null}
    <h3 className="font-medium">Your plugins</h3>
    {plugins.filter(row => `${pluginManifest(row).name} ${row.plugin_id}`.toLowerCase().includes(query.toLowerCase())).map(row => <section key={row.id} className="rounded border p-3">
      <h4>{pluginManifest(row).name}</h4><p>{row.principal === 'space' ? 'Applied to this space' : 'Installed for you'} · {row.enabled ? 'Enabled' : 'Disabled'}</p>
      <p className="text-xs">Access: {pluginManifest(row).capabilities.map(cap => cap.kind === 'net:fetch' ? `Network: ${cap.hosts?.join(', ')}` : cap.kind).join(', ') || 'None'}</p>
      <Button disabled={busy || (row.principal === 'space' && !canManage)} onClick={() => void change(() => togglePlugin(row.id, !row.enabled))}>{row.enabled ? 'Disable' : 'Enable'}</Button>
      <Button variant="outline" disabled={busy || (row.principal === 'space' && !canManage)} onClick={() => { if (window.confirm(`Remove ${pluginManifest(row).name}?`)) void change(() => removePlugin(row.id)); }}>Remove</Button>
    </section>)}
    <details><summary>Import a plugin</summary><p className="text-sm">Paste canopy.json and its JavaScript entry source. Imported code runs in a sandbox with access only to the opened file and the declared network hosts.</p>
      <label>Plugin manifest<textarea className="w-full rounded border p-2" aria-label="Plugin manifest" value={manifest} onChange={event => setManifest(event.target.value)} /></label>
      <label>Plugin source<textarea className="w-full rounded border p-2" aria-label="Plugin source" value={source} onChange={event => setSource(event.target.value)} /></label>
      {canManage ? <label><input type="checkbox" checked={forSpace} onChange={event => setForSpace(event.target.checked)} />Apply to this space</label> : null}
      <Button disabled={busy || !manifest || !source} onClick={() => void change(async () => { const parsed = JSON.parse(manifest) as {id: string}; const previous = plugins.find(row => row.plugin_id === parsed.id && (row.principal === 'space') === forSpace); if (previous && !window.confirm('Replace this installed plugin and its source?')) return; await savePlugin(parsed, source, previous?.updated_at ?? null, forSpace); setManifest(''); setSource(''); })}>Install plugin</Button>
    </details>
    <h3 className="font-medium">Available plugins</h3>
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
