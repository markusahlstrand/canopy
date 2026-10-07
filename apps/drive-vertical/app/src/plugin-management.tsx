import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Icon, Input, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, cn } from '@canopy/ui';
import { setImageViewerEnabled, viewerRegistry } from './image-viewer';
import { peopleAccess, pluginSource, savePlugin, togglePlugin, removePlugin, importGithubPlugin, importNpmPlugin } from './api';
import { catalogMatchesSearch, pluginCatalog } from './plugin-catalog';
import { SandboxPlugin } from './sandbox-plugin';
import { PluginAiHandoff } from './plugin-ai-handoff';
import { useUnsavedDraft, confirmDiscardDrafts } from './drafts';
import type { PluginInstall } from './api';
import { effectivePlugins, installedPluginMatchesSearch, installedViewerMatchesSearch, refreshPlugins, useInstalledPlugins, pluginManifest } from './installed-plugins';
import { installedPluginManifest } from '@canopy/scope-drive/spec/model';
import { resolveZipBytes } from '@canopy/plugin-sources';
import type { PluginProvenance } from './api';
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
function catalogInstallStatus(row: PluginInstall, scope: string): string {
  if (pluginManifest(row).invalid) return `Needs repair ${scope}`;
  return `${row.enabled ? 'Enabled' : 'Disabled'} ${scope}`;
}
/** Manage installed viewer contributions; available plugins are reviewed and bundled. */
export function PluginManagement({ open, onOpenChange, onOpenApp, spaceName }: { open: boolean; onOpenChange: (open: boolean) => void; onOpenApp?: (id: string) => boolean | void; spaceName?: string }) {
  useSyncExternalStore(viewerRegistry.subscribe, viewerRegistry.snapshot);
  const [studioOpen, setStudioOpen] = useState(false);
  const [editingInstall, setEditingInstall] = useState<PluginInstall | null>(null);
  const plugins = useInstalledPlugins();
  const [manifest, setManifest] = useState('');
  const [source, setSource] = useState('');
  const manifestRead = useRef(0), sourceRead = useRef(0);
  const [studioError, setStudioError] = useState<string | null>(null);
  const [imported, setImported] = useState<{ manifest: string; source: string; provenance: PluginProvenance } | null>(null);
  const [githubRepo, setGithubRepo] = useState(''), [githubRef, setGithubRef] = useState(''), [githubPath, setGithubPath] = useState('');
  const [npmName, setNpmName] = useState(''), [npmVersion, setNpmVersion] = useState('');
  const manifestCheck = validateManifest(manifest);
  const [approved, setApproved] = useState(false);

  useUnsavedDraft(open && (!!manifest || !!source));
  const [forSpace, setForSpace] = useState(false);
  useEffect(() => {setApproved(false);}, [manifest, source, forSpace]);
  const [canManage, setCanManage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pluginsState, setPluginsState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const canChangeInstall = pluginsState !== 'failed' && !busy;
  const [loadRetry, setLoadRetry] = useState(0);
  useEffect(() => {
    if (!open) { setPluginsState('loading'); setError(null); return; }
    let alive = true;
    setPluginsState('loading');
    setError(null);
    setCanManage(false);
    refreshPlugins().then(() => { if (alive) setPluginsState('loaded'); }).catch(() => {
      if (alive) { setPluginsState('failed'); setError('Could not load installed plugins.'); }
    });
    peopleAccess().then(result => { if (alive) setCanManage(result.canManage); }).catch(() => {});
    return () => { alive = false; };
  }, [open, loadRetry]);
  const change = async (action: () => Promise<unknown>) => { setBusy(true); setError(null); try { await action(); await refreshPlugins(); } catch (error) { setError(error instanceof Error ? error.message || 'Could not update this plugin.' : String(error)); } finally { setBusy(false); } };
  const editSource = async (row: PluginInstall) => {
    if (!confirmDiscardDrafts()) return;
    const manifestToken = ++manifestRead.current, sourceToken = ++sourceRead.current;
    setBusy(true); setError(null);
    try {
      const loaded = await pluginSource(row.id, row.updated_at);
      if (manifestRead.current !== manifestToken || sourceRead.current !== sourceToken) return;
      const parsed = pluginManifest(loaded);
      setEditingInstall(loaded);
      setManifest(parsed.invalid ? loaded.manifest_json : JSON.stringify(parsed, null, 2));
      setSource(loaded.source);
      setForSpace(loaded.principal === 'space');
      setStudioOpen(true);
    } catch (error) {
      if (manifestRead.current === manifestToken && sourceRead.current === sourceToken)
        setError(error instanceof Error ? error.message || 'Could not load plugin source.' : String(error));
    } finally { setBusy(false); }
  };
  const [query, setQuery] = useState('');
  const [installScope, setInstallScope] = useState<'all' | 'personal' | 'space'>('all');
  const [category, setCategory] = useState('All');
  const categories = ['All', ...new Set(pluginCatalog.map(entry => entry.category))];
  const enabled = viewerRegistry.has('image-viewer');
  const installed = viewerRegistry.list();
  const activeRuntimeViewers = effectivePlugins(plugins)
    .filter(row => row.enabled === 1)
    .flatMap(row => {
      const manifest = pluginManifest(row);
      return (manifest.contributes.viewers ?? []).map(viewer => ({ row, viewer, name: manifest.name }));
    })
    .filter(({ row, viewer }) => installedViewerMatchesSearch(row, viewer, query));
  const visibleBuiltInViewers = installed.filter(plugin => `${plugin.pluginId} ${plugin.id}`.toLowerCase().includes(query.toLowerCase()));
  const visiblePlugins = plugins.filter(row =>
    (installScope === 'all' || (row.principal === 'space') === (installScope === 'space')) && installedPluginMatchesSearch(row, query));
  const launchableIds = new Set(effectivePlugins(plugins).filter(row => row.enabled === 1 && !!pluginManifest(row).contributes.detailView).map(row => row.id));
  const available = pluginCatalog.filter(entry =>
    (category === 'All' || entry.category === category) &&
    catalogMatchesSearch(entry, query),
  );
  const showImageViewer = (category === 'All' || category === 'Viewers') && 'image viewer'.includes(query.toLowerCase());
  const reviewCatalog = (entry: (typeof pluginCatalog)[number], targetSpace: boolean) => {
    if (!confirmDiscardDrafts()) return;
    manifestRead.current++; sourceRead.current++;
    setEditingInstall(null);
    setImported(null);
    setManifest(JSON.stringify(entry.manifest, null, 2));
    setSource(entry.source);
    setForSpace(targetSpace);
    setStudioOpen(true);
  };
  const readLocalFile = async (file: File | undefined, target: 'manifest' | 'source') => {
    if (!file) return;
    if ((target === 'manifest' ? manifest : source) && !confirmDiscardDrafts()) return;
    const counter = target === 'manifest' ? manifestRead : sourceRead;
    const token = ++counter.current;
    setStudioError(null);
    setApproved(false);
    if (file.size > 256_000) { setStudioError(`Plugin ${target} file is too large.`); return; }
    try {
      const contents = await file.text();
      if (counter.current !== token) return;
      setImported(null);
      if (target === 'manifest') setManifest(contents); else setSource(contents);
    } catch { if (counter.current === token) setStudioError(`Could not read plugin ${target} file.`); }
  };
  const close = () => {
    setEditingInstall(null);
    setManifest('');
    setSource('');
    manifestRead.current++; sourceRead.current++; setStudioError(null);
    setImported(null);
    setApproved(false);
    setForSpace(false);
    setStudioOpen(false);
    onOpenChange(false);
  };
  const handleOpenChange = (next: boolean) => {
    if (next) onOpenChange(true);
    else if (confirmDiscardDrafts()) close();
  };
  return <Dialog open={open} onOpenChange={handleOpenChange}><DialogContent className="max-h-[85vh] overflow-auto sm:max-w-[760px]">
    <DialogHeader><DialogTitle>Plugins</DialogTitle><DialogDescription>Install file viewers for yourself or apply them to {spaceName ? `“${spaceName}”` : 'the current space'}. Review the access requested by each plugin before installing.</DialogDescription></DialogHeader>
    <Input aria-label="Find a plugin" placeholder="Find a plugin" value={query} onChange={event => setQuery(event.target.value)} />
    {error ? <p role="alert">{error}</p> : null}
    <div><h3 className="font-medium">Your plugins</h3><p className="text-xs text-muted-foreground">Installed for you or applied to {spaceName ?? 'this space'}.</p></div>
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Installed plugin scope">
      {([['all', 'All installs'], ['personal', 'Personal installs'], ['space', 'Space installs']] as const).map(([value, label]) =>
        <button key={value} type="button" aria-pressed={installScope === value} onClick={() => setInstallScope(value)}
          className={cn('rounded-full px-3 py-1 text-xs font-medium transition-colors', installScope === value ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-secondary/70')}>{label}</button>)}
    </div>
    {pluginsState === 'loading' ? <p role="status" className="text-sm text-muted-foreground">Loading installed plugins…</p> : null}
    {pluginsState === 'failed' ? <Button size="sm" variant="outline" onClick={() => setLoadRetry(value => value + 1)}>Retry installed plugins</Button> : null}
    {pluginsState === 'failed' && plugins.length ? <p className="text-xs text-muted-foreground">Showing the last plugin list. Changes are unavailable until it refreshes.</p> : null}
    {pluginsState !== 'loading' && visiblePlugins.length ? <div className="grid gap-3 sm:grid-cols-2">{visiblePlugins.map(row => {
      const manifest = pluginManifest(row);
      return <section key={row.id} className="flex min-w-0 flex-col gap-2.5 rounded-lg border p-3.5">
        <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-md bg-primary/10 text-primary"><Icon name={manifest.contributes.detailView ? 'plugin' : 'file-text'} size={20} /></span><div className="min-w-0 flex-1"><h4 className="truncate font-medium">{manifest.name}</h4><p className="text-xs text-muted-foreground">{row.principal === 'space' ? `Applied to ${spaceName ?? 'this space'}` : 'Installed for you'}</p></div><span className="rounded-full bg-secondary px-2 py-0.5 text-[11px]">{manifest.invalid ? 'Needs repair' : row.enabled ? 'Enabled' : 'Disabled'}</span></div>
        <p className="text-xs text-muted-foreground">Source: {row.source_kind ?? 'inline'} · {row.source_ref ?? 'Client-supplied JavaScript'} {row.resolved ?? ''}</p>
        {row.source_sha256 ? <details className="text-xs"><summary>Source fingerprint</summary><code className="break-all">{row.source_sha256}</code></details> : null}
        <p className="text-xs text-muted-foreground">Access: {manifest.capabilities.map(cap => cap.kind === 'net:fetch' ? `Network: ${cap.hosts?.join(', ')}` : cap.kind).join(', ') || 'None'}</p>
        {manifest.contributes.viewers?.length ? <p className="text-xs text-muted-foreground">Handles: {manifest.contributes.viewers.flatMap(viewer => viewer.match).join(', ')}</p> : null}
        <div className="mt-auto flex flex-wrap gap-1.5">
          <Button size="sm" disabled={!canChangeInstall || (row.principal === 'space' && !canManage) || (manifest.invalid && !row.enabled)} onClick={() => void change(() => togglePlugin(row.id, !row.enabled))}>{row.enabled ? 'Disable' : manifest.invalid ? 'Repair to enable' : 'Enable'}</Button>
          <Button size="sm" variant="outline" disabled={!canChangeInstall || (row.principal === 'space' && !canManage)} onClick={() => void editSource(row)}>Edit source</Button>
          {launchableIds.has(row.id) && onOpenApp ? <Button size="sm" variant="outline" disabled={pluginsState !== 'loaded'} onClick={() => { if (!confirmDiscardDrafts()) return; if (onOpenApp(row.id) !== false) close(); }}>Open app</Button> : null}
          <Button size="sm" variant="ghost" disabled={!canChangeInstall || (row.principal === 'space' && !canManage)} onClick={() => { if (window.confirm(`Remove ${manifest.name}?`)) void change(() => removePlugin(row.id)); }}>Remove</Button>
        </div>
      </section>;
    })}</div> : pluginsState === 'loaded' && !error && !busy ? <p className="rounded-lg border border-dashed p-5 text-center text-sm text-muted-foreground">{query || installScope !== 'all' ? 'No installed plugins match these filters.' : 'No plugins installed yet.'}</p> : null}
    <Button variant="outline" onClick={() => { if (!confirmDiscardDrafts()) return; manifestRead.current++; sourceRead.current++; setEditingInstall(null); setManifest(JSON.stringify({id:'my-plugin',name:'My plugin',version:'0.1.0',capabilities:[{kind:'item:read'}],contributes:{viewers:[{id:'text',title:'Text',match:['text/*']}]}}, null, 2)); setSource('export default function render({container, file}) {\n  container.textContent = new TextDecoder().decode(file.bytes);\n}\n'); setForSpace(false); setStudioOpen(true); }}>Build a plugin</Button>
    <PluginAiHandoff />
    <details open={studioOpen} onToggle={event => setStudioOpen(event.currentTarget.open)}><summary>Plugin Studio · import or edit source</summary><p className="text-sm">Paste or choose canopy.json and its JavaScript entry source. Imported code cannot access your Canopy session. A plugin that can read a file can send its contents elsewhere, even without declared network hosts. Install only code you trust.</p>
      <div className="flex flex-wrap gap-3 text-sm">
        <label>Choose canopy.json <input type="file" accept=".json,application/json" aria-label="Choose plugin manifest file" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void readLocalFile(file, 'manifest'); }} /></label>
        <label>Choose JavaScript <input type="file" accept=".js,.mjs,text/javascript" aria-label="Choose plugin source file" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void readLocalFile(file, 'source'); }} /></label>
        <label>Choose plugin ZIP <input type="file" accept=".zip,application/zip" aria-label="Choose plugin ZIP file" onChange={event => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
          if (!file || ((manifest || source) && !confirmDiscardDrafts())) return;
          const manifestToken = ++manifestRead.current, sourceToken = ++sourceRead.current;
          setStudioError(null); setApproved(false);
          if (file.size > 8 * 1024 * 1024) { setStudioError('Plugin ZIP is too large.'); return; }
          void file.arrayBuffer().then(buffer => {
            const result = resolveZipBytes(new Uint8Array(buffer), {type:'zip',key:file.name});
            if (!('code' in result.entry) || result.entry.modules && Object.keys(result.entry.modules).length) throw new Error('This ZIP contains multiple JavaScript modules; import a bundled entry file instead.');
            const nextManifest = JSON.stringify(result.manifest,null,2), nextSource = result.entry.code;
            if (nextManifest.length > 256_000) throw new Error('Plugin manifest in this ZIP is too large.');
            if (nextSource.length > 256_000) throw new Error('Plugin source in this ZIP is too large.');
            if (manifestRead.current !== manifestToken || sourceRead.current !== sourceToken) return;
            setManifest(nextManifest); setSource(nextSource); setImported({manifest:nextManifest,source:nextSource,provenance:{kind:'zip',ref:file.name,resolved:result.version}}); setEditingInstall(null); setApproved(false); setStudioOpen(true);
          }).catch(error => { if (manifestRead.current === manifestToken && sourceRead.current === sourceToken) setStudioError(error instanceof Error ? error.message : 'Could not read plugin ZIP.'); });
        }} /></label>
      </div>
      {studioError ? <p role="alert" className="text-sm text-destructive">{studioError}</p> : null}
      <div className="space-y-2 rounded-lg border p-3 text-sm">
        <p className="font-medium">Import from public GitHub</p>
        <div className="grid gap-2 sm:grid-cols-3">
          <Input aria-label="GitHub repository" placeholder="owner/repository" value={githubRepo} onChange={event=>setGithubRepo(event.target.value)} />
          <Input aria-label="GitHub ref" placeholder="Branch or commit SHA (main)" value={githubRef} onChange={event=>setGithubRef(event.target.value)} />
          <Input aria-label="GitHub plugin folder" placeholder="Folder (optional)" value={githubPath} onChange={event=>setGithubPath(event.target.value)} />
        </div>
        <Button variant="outline" disabled={busy || !githubRepo.trim()} onClick={() => {
          if ((manifest || source) && !confirmDiscardDrafts()) return;
          const manifestToken = ++manifestRead.current, sourceToken = ++sourceRead.current;
          setBusy(true); setStudioError(null); setApproved(false);
          void importGithubPlugin(githubRepo.trim(),githubRef.trim(),githubPath.trim()).then(result => {
            if (manifestRead.current !== manifestToken || sourceRead.current !== sourceToken) return;
            const nextManifest=JSON.stringify(result.manifest,null,2);
            setManifest(nextManifest); setSource(result.source); setImported({manifest:nextManifest,source:result.source,provenance:result.provenance}); setEditingInstall(null); setApproved(false); setStudioOpen(true);
          }).catch(error => { if (manifestRead.current === manifestToken && sourceRead.current === sourceToken) setStudioError(error instanceof Error ? error.message : String(error)); }).finally(()=>setBusy(false));
        }}>Review GitHub plugin</Button>
      </div>
      <div className="space-y-2 rounded-lg border p-3 text-sm">
        <p className="font-medium">Import from npm</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Input aria-label="npm package" placeholder="@scope/package" value={npmName} onChange={event=>setNpmName(event.target.value)} />
          <Input aria-label="npm version or tag" placeholder="Version or tag (latest)" value={npmVersion} onChange={event=>setNpmVersion(event.target.value)} />
        </div>
        <Button variant="outline" disabled={busy || !npmName.trim()} onClick={() => {
          if ((manifest || source) && !confirmDiscardDrafts()) return;
          const manifestToken = ++manifestRead.current, sourceToken = ++sourceRead.current;
          setBusy(true); setStudioError(null); setApproved(false);
          void importNpmPlugin(npmName.trim(), npmVersion.trim()).then(result => {
            if (manifestRead.current !== manifestToken || sourceRead.current !== sourceToken) return;
            const nextManifest = JSON.stringify(result.manifest, null, 2);
            setManifest(nextManifest); setSource(result.source); setImported({manifest:nextManifest,source:result.source,provenance:result.provenance}); setEditingInstall(null); setApproved(false); setStudioOpen(true);
          }).catch(error => { if (manifestRead.current === manifestToken && sourceRead.current === sourceToken) setStudioError(error instanceof Error ? error.message : String(error)); }).finally(() => setBusy(false));
        }}>Review npm plugin</Button>
      </div>
      <label>Plugin manifest<textarea className="w-full rounded border p-2" aria-label="Plugin manifest" value={manifest} onChange={event => { manifestRead.current++; setManifest(event.target.value); }} /></label>
      {manifestCheck.error ? <p role="alert" className="text-sm text-destructive">{manifestCheck.error}</p> : null}
      <label>Plugin source<textarea className="w-full rounded border p-2" aria-label="Plugin source" value={source} onChange={event => { sourceRead.current++; setSource(event.target.value); }} /></label>
      {canManage ? <label><input type="checkbox" checked={forSpace} onChange={event => setForSpace(event.target.checked)} />Apply to {spaceName ?? 'this space'}</label> : null}
      <label className="block"><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} />Approve the capabilities in this manifest, including added access. Read access lets the plugin share the opened file outside Canopy.</label>
      <Button disabled={!canChangeInstall || !manifestCheck.manifest || !source.trim() || !approved} onClick={() => void change(async () => { const parsed = manifestCheck.manifest!; const previous = plugins.find(row => row.plugin_id === parsed.id && (row.principal === 'space') === forSpace); if (previous && !window.confirm('Replace this installed plugin and its source?')) return; const revision = editingInstall?.plugin_id === parsed.id && (editingInstall.principal === 'space') === forSpace ? editingInstall.updated_at : previous?.updated_at ?? null; const bundled = pluginCatalog.find(entry => { const candidate = installedPluginManifest.safeParse(entry.manifest); return candidate.success && JSON.stringify(candidate.data) === JSON.stringify(parsed) && entry.source === source; }); const provenance = bundled ? {kind:'bundled' as const,ref:`@canopy/catalog/${parsed.id}`,resolved:parsed.version} : imported?.manifest === manifest && imported.source === source ? imported.provenance : undefined; await savePlugin(parsed, source, revision, forSpace, parsed.capabilities, provenance); setEditingInstall(null); setManifest(''); setSource(''); setImported(null); })}>Install plugin</Button>
    </details>
    <div><h3 className="font-medium">Available plugins</h3><p className="text-xs text-muted-foreground">Browse reviewed viewers and editors, then approve their access before installing.</p></div>
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Plugin categories">{categories.map(value => <button key={value} type="button" aria-pressed={category === value} onClick={() => setCategory(value)} className={cn('rounded-full px-3 py-1 text-xs font-medium transition-colors', category === value ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-secondary/70')}>{value}</button>)}</div>
    <div className="grid gap-3 sm:grid-cols-2">{available.map(entry => <section key={entry.manifest.id} className="flex min-w-0 flex-col gap-2.5 rounded-lg border p-3.5">
      <div className="flex items-start justify-between"><span className="grid size-11 place-items-center rounded-md" style={{ backgroundColor: `${entry.color}24`, color: entry.color }}><Icon name={entry.icon} size={20} /></span><span className="flex flex-wrap justify-end gap-1">{plugins.filter(row => row.plugin_id === entry.manifest.id).map(row => <span key={row.id} className="rounded-full bg-secondary px-2 py-0.5 text-[11px]">{catalogInstallStatus(row, row.principal === 'space' ? `in ${spaceName ?? 'this space'}` : 'for you')}</span>)}</span></div>
      <div><h4 className="font-medium">{entry.manifest.name}</h4><p className="text-xs text-muted-foreground">{entry.category}</p></div>
      <p className="flex-1 text-sm text-muted-foreground">{entry.manifest.description}</p>
      <p className="text-xs text-muted-foreground">Access: {entry.manifest.capabilities.map(cap => cap.kind === 'net:fetch' ? `Network: ${cap.hosts?.join(', ')}` : cap.kind).join(', ')}. File-read plugins can share opened files outside Canopy.{entry.manifest.capabilities.some(cap => cap.kind === 'net:fetch') ? ' Listed hosts serve code that runs with the opened file.' : ''}</p>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => reviewCatalog(entry, false)}>Review {entry.manifest.name}</Button>
        {canManage ? <Button variant="outline" disabled={busy} onClick={() => reviewCatalog(entry, true)}>Apply {entry.manifest.name} to {spaceName ?? 'space'}</Button> : null}</div>
    </section>)}</div>
    {showImageViewer ? <section aria-label="Image viewer" className="space-y-2 rounded border p-3">
      <h4 className="font-medium">Image viewer</h4><p className="text-sm">Preview images with zoom and keyboard controls.</p>
      <p className="text-xs text-muted-foreground">Built in · Trusted Canopy component · No editing</p>
      <p role="status">{enabled ? 'Enabled' : 'Disabled'}</p>
      <Button size="sm" variant="outline" onClick={() => setImageViewerEnabled(!enabled)}>{enabled ? 'Disable image viewer' : 'Enable image viewer'}</Button>
    </section> : null}
    {available.length === 0 && !showImageViewer ? <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No available plugins match this search.</p> : null}
    <h3 className="font-medium">Active file viewers</h3>
    {visibleBuiltInViewers.length || activeRuntimeViewers.length ? <ul className="space-y-2">{visibleBuiltInViewers.map(plugin => <li key={`${plugin.pluginId}:${plugin.id}`} className="rounded border p-2">
      <p>{plugin.pluginId} / {plugin.id}</p><p className="text-xs text-muted-foreground">Handles: {plugin.match.join(', ')}</p>
    </li>)}{activeRuntimeViewers.map(({ row, viewer, name }) => <li key={`${row.id}:${viewer.id}`} className="rounded border p-2">
      <p>{viewer.title ?? name} <span className="text-xs text-muted-foreground">· {row.principal === 'space' ? 'This space' : 'For you'}</span></p>
      <p className="text-xs text-muted-foreground">Handles: {viewer.match.join(', ')}</p>
    </li>)}</ul> : <p>No optional viewers are enabled.</p>}
    <p className="text-xs text-muted-foreground">Preferences apply to this browser, including its other open tabs.</p>
  </DialogContent></Dialog>;
}
