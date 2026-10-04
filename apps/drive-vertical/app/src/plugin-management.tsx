import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button, Icon, Input, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, cn } from '@canopy/ui';
import { setImageViewerEnabled, viewerRegistry } from './image-viewer';
import { peopleAccess, pluginSource, savePlugin, togglePlugin, removePlugin } from './api';
import { pluginCatalog } from './plugin-catalog';
import { SandboxPlugin } from './sandbox-plugin';
import { useUnsavedDraft, confirmDiscardDrafts } from './drafts';
import type { PluginInstall } from './api';
import { refreshPlugins, useInstalledPlugins, pluginManifest } from './installed-plugins';
import { installedPluginManifest } from '@canopy/scope-drive/spec/model';
function validateManifest(text: string) {
  if (!text.trim()) return { manifest: null, error: null };
  try {
    const result = installedPluginManifest.safeParse(JSON.parse(text));
    if (result.success) return { manifest: result.data, error: null };
    const issue = result.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    return { manifest: null, error: `${path}${issue?.message ?? 'Invalid plugin manifest.'}` };
  } catch { return { manifest: null, error: 'Manifest must contain valid JSON.' }; }
}
/** Manage installed viewer contributions; available plugins are reviewed and bundled. */
export function PluginManagement({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  useSyncExternalStore(viewerRegistry.subscribe, viewerRegistry.snapshot);
  const [studioOpen, setStudioOpen] = useState(false);
  const [editingInstall, setEditingInstall] = useState<PluginInstall | null>(null);
  const [app, setApp] = useState<PluginInstall | null>(null);
  const plugins = useInstalledPlugins();
  const [manifest, setManifest] = useState('');
  const [source, setSource] = useState('');
  const manifestCheck = validateManifest(manifest);
  const [approved, setApproved] = useState(false);

  useUnsavedDraft(open && (!!manifest || !!source));
  const [forSpace, setForSpace] = useState(false);
  useEffect(() => {setApproved(false);}, [manifest,forSpace]);
  const [canManage, setCanManage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pluginsState, setPluginsState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  useEffect(() => {
    if (!open) { setPluginsState('loading'); setError(null); return; }
    let alive = true;
    setPluginsState('loading');
    setError(null);
    refreshPlugins().then(() => { if (alive) setPluginsState('loaded'); }).catch(() => {
      if (alive) { setPluginsState('failed'); setError('Could not load installed plugins.'); }
    });
    peopleAccess().then(result => { if (alive) setCanManage(result.canManage); }).catch(() => {});
    return () => { alive = false; };
  }, [open]);
  const change = async (action: () => Promise<unknown>) => { setBusy(true); setError(null); try { await action(); await refreshPlugins(); } catch (error) { setError(error instanceof Error ? error.message || 'Could not update this plugin.' : String(error)); } finally { setBusy(false); } };
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'All' | 'Viewers' | 'Editors'>('All');
  const enabled = viewerRegistry.has('image-viewer');
  const installed = viewerRegistry.list();
  const visiblePlugins = plugins.filter(row => `${pluginManifest(row).name} ${row.plugin_id}`.toLowerCase().includes(query.toLowerCase()));
  const available = pluginCatalog.filter(entry =>
    (category === 'All' || entry.category === category) &&
    `${entry.manifest.name} ${entry.manifest.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  const showImageViewer = (category === 'All' || category === 'Viewers') && 'image viewer'.includes(query.toLowerCase());
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      if (!confirmDiscardDrafts()) return;
      setEditingInstall(null);
      setManifest('');
      setSource('');
      setApproved(false);
      setForSpace(false);
      setStudioOpen(false);
      setApp(null);
    }
    onOpenChange(next);
  };
  return <Dialog open={open} onOpenChange={handleOpenChange}><DialogContent className="max-h-[85vh] overflow-auto sm:max-w-[760px]">
    <DialogHeader><DialogTitle>Plugins</DialogTitle><DialogDescription>Install file viewers for yourself or apply them to the current space. Review the access requested by each plugin before installing.</DialogDescription></DialogHeader>
    <Input aria-label="Find a plugin" placeholder="Find a plugin" value={query} onChange={event => setQuery(event.target.value)} />
    {error ? <p role="alert">{error}</p> : null}
    <div><h3 className="font-medium">Your plugins</h3><p className="text-xs text-muted-foreground">Installed for you or applied to this space.</p></div>
    {pluginsState === 'loading' ? <p role="status" className="text-sm text-muted-foreground">Loading installed plugins…</p> : null}
    {pluginsState === 'loaded' && visiblePlugins.length ? <div className="grid gap-3 sm:grid-cols-2">{visiblePlugins.map(row => {
      const manifest = pluginManifest(row);
      return <section key={row.id} className="flex min-w-0 flex-col gap-2.5 rounded-lg border p-3.5">
        <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-md bg-primary/10 text-primary"><Icon name={manifest.contributes.detailView ? 'plugin' : 'file-text'} size={20} /></span><div className="min-w-0 flex-1"><h4 className="truncate font-medium">{manifest.name}</h4><p className="text-xs text-muted-foreground">{row.principal === 'space' ? 'Applied to this space' : 'Installed for you'}</p></div><span className="rounded-full bg-secondary px-2 py-0.5 text-[11px]">{row.enabled ? 'Enabled' : 'Disabled'}</span></div>
        <p className="text-xs text-muted-foreground">Origin (client-claimed): {row.source_kind ?? 'inline'} · {row.source_ref ?? 'Client-supplied JavaScript'} {row.resolved ?? ''}</p>
        {row.source_sha256 ? <details className="text-xs"><summary>Source fingerprint</summary><code className="break-all">{row.source_sha256}</code></details> : null}
        <p className="text-xs text-muted-foreground">Access: {manifest.capabilities.map(cap => cap.kind === 'net:fetch' ? `Network: ${cap.hosts?.join(', ')}` : cap.kind).join(', ') || 'None'}</p>
        <div className="mt-auto flex flex-wrap gap-1.5">
          <Button size="sm" disabled={busy || (row.principal === 'space' && !canManage)} onClick={() => void change(() => togglePlugin(row.id, !row.enabled))}>{row.enabled ? 'Disable' : 'Enable'}</Button>
          <Button size="sm" variant="outline" disabled={busy || (row.principal === 'space' && !canManage)} onClick={() => { if (!confirmDiscardDrafts()) return; void change(async () => {const loaded = await pluginSource(row.id,row.updated_at); setEditingInstall(loaded); setManifest(JSON.stringify(pluginManifest(loaded),null,2)); setSource(loaded.source);setForSpace(loaded.principal==='space');setStudioOpen(true);}); }}>Edit source</Button>
          {row.enabled && manifest.contributes.detailView ? <Button size="sm" variant="outline" onClick={() => setApp(row)}>Open app</Button> : null}
          <Button size="sm" variant="ghost" disabled={busy || (row.principal === 'space' && !canManage)} onClick={() => { if (window.confirm(`Remove ${manifest.name}?`)) void change(() => removePlugin(row.id)); }}>Remove</Button>
        </div>
      </section>;
    })}</div> : pluginsState === 'loaded' && !error && !busy ? <p className="rounded-lg border border-dashed p-5 text-center text-sm text-muted-foreground">{query ? 'No installed plugins match this search.' : 'No plugins installed yet.'}</p> : null}
    {app ? <section><Button variant="outline" onClick={() => setApp(null)}>Close app</Button><SandboxPlugin key={app.id} plugin={app} /></section> : null}
    <Button variant="outline" onClick={() => { if (!confirmDiscardDrafts()) return; setEditingInstall(null); setManifest(JSON.stringify({id:'my-plugin',name:'My plugin',version:'0.1.0',capabilities:[{kind:'item:read'}],contributes:{viewers:[{id:'text',title:'Text',match:['text/*']}]}}, null, 2)); setSource('export default function render({container, file}) {\n  container.textContent = new TextDecoder().decode(file.bytes);\n}\n'); setForSpace(false); setStudioOpen(true); }}>Build a plugin</Button>
    <details open={studioOpen} onToggle={event => setStudioOpen(event.currentTarget.open)}><summary>Plugin Studio · import or edit source</summary><p className="text-sm">Paste canopy.json and its JavaScript entry source. Imported code cannot access your Canopy session. A plugin that can read a file can send its contents elsewhere, even without declared network hosts. Install only code you trust.</p>
      <label>Plugin manifest<textarea className="w-full rounded border p-2" aria-label="Plugin manifest" value={manifest} onChange={event => setManifest(event.target.value)} /></label>
      {manifestCheck.error ? <p role="alert" className="text-sm text-destructive">{manifestCheck.error}</p> : null}
      <label>Plugin source<textarea className="w-full rounded border p-2" aria-label="Plugin source" value={source} onChange={event => setSource(event.target.value)} /></label>
      {canManage ? <label><input type="checkbox" checked={forSpace} onChange={event => setForSpace(event.target.checked)} />Apply to this space</label> : null}
      <label className="block"><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} />Approve the capabilities in this manifest, including added access. Read access lets the plugin share the opened file outside Canopy.</label>
      <Button disabled={busy || !manifestCheck.manifest || !source.trim() || !approved} onClick={() => void change(async () => { const parsed = manifestCheck.manifest!; const previous = plugins.find(row => row.plugin_id === parsed.id && (row.principal === 'space') === forSpace); if (previous && !window.confirm('Replace this installed plugin and its source?')) return; const revision = editingInstall?.plugin_id === parsed.id && (editingInstall.principal === 'space') === forSpace ? editingInstall.updated_at : previous?.updated_at ?? null; const bundled = pluginCatalog.find(entry => { const candidate = installedPluginManifest.safeParse(entry.manifest); return candidate.success && JSON.stringify(candidate.data) === JSON.stringify(parsed) && entry.source === source; }); await savePlugin(parsed, source, revision, forSpace, parsed.capabilities, bundled ? {kind:'bundled',ref:`@canopy/catalog/${parsed.id}`,resolved:parsed.version} : undefined); setEditingInstall(null); setManifest(''); setSource(''); })}>Install plugin</Button>
    </details>
    <div><h3 className="font-medium">Available plugins</h3><p className="text-xs text-muted-foreground">Browse reviewed viewers and editors, then approve their access before installing.</p></div>
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Plugin categories">{(['All', 'Viewers', 'Editors'] as const).map(value => <button key={value} type="button" aria-pressed={category === value} onClick={() => setCategory(value)} className={cn('rounded-full px-3 py-1 text-xs font-medium transition-colors', category === value ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-secondary/70')}>{value}</button>)}</div>
    <div className="grid gap-3 sm:grid-cols-2">{available.map(entry => <section key={entry.manifest.id} className="flex min-w-0 flex-col gap-2.5 rounded-lg border p-3.5">
      <div className="flex items-start justify-between"><span className="grid size-11 place-items-center rounded-md" style={{ backgroundColor: `${entry.color}24`, color: entry.color }}><Icon name={entry.icon} size={20} /></span>{plugins.some(row => row.plugin_id === entry.manifest.id) ? <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px]">Installed</span> : null}</div>
      <div><h4 className="font-medium">{entry.manifest.name}</h4><p className="text-xs text-muted-foreground">{entry.category}</p></div>
      <p className="flex-1 text-sm text-muted-foreground">{entry.manifest.description}</p>
      <p className="text-xs text-muted-foreground">Access: {entry.manifest.capabilities.map(cap => cap.kind === 'net:fetch' ? `Network: ${cap.hosts?.join(', ')}` : cap.kind).join(', ')}. File-read plugins can share opened files outside Canopy.{entry.manifest.capabilities.some(cap => cap.kind === 'net:fetch') ? ' Listed hosts serve code that runs with the opened file.' : ''}</p>
      <Button variant="outline" disabled={busy} onClick={() => { if (!confirmDiscardDrafts()) return; setEditingInstall(null); setManifest(JSON.stringify(entry.manifest, null, 2)); setSource(entry.source); setForSpace(false); setStudioOpen(true); }}>Review {entry.manifest.name}</Button>
    </section>)}</div>
    {showImageViewer ? <section aria-label="Image viewer" className="space-y-2 rounded border p-3">
      <h4 className="font-medium">Image viewer</h4><p className="text-sm">Preview images with zoom and keyboard controls.</p>
      <p className="text-xs text-muted-foreground">Built in · Trusted Canopy component · No editing</p>
      <p role="status">{enabled ? 'Enabled' : 'Disabled'}</p>
      <Button size="sm" variant="outline" onClick={() => setImageViewerEnabled(!enabled)}>{enabled ? 'Disable image viewer' : 'Enable image viewer'}</Button>
    </section> : null}
    {available.length === 0 && !showImageViewer ? <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No available plugins match this search.</p> : null}
    <h3 className="font-medium">Active file viewers</h3>
    {installed.length ? <ul className="space-y-2">{installed.filter(plugin => `${plugin.pluginId} ${plugin.id}`.toLowerCase().includes(query.toLowerCase())).map(plugin => <li key={`${plugin.pluginId}:${plugin.id}`} className="rounded border p-2">
      <p>{plugin.pluginId} / {plugin.id}</p><p className="text-xs text-muted-foreground">Handles: {plugin.match.join(', ')}</p>
    </li>)}</ul> : <p>No optional viewers are enabled.</p>}
    <p className="text-xs text-muted-foreground">Preferences apply to this browser, including its other open tabs.</p>
  </DialogContent></Dialog>;
}
