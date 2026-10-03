import { useState, useSyncExternalStore } from 'react';
import { Button, Input, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@canopy/ui';
import { setImageViewerEnabled, viewerRegistry } from './image-viewer';
/** Manage installed viewer contributions; available plugins are reviewed and bundled. */
export function PluginManagement({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  useSyncExternalStore(viewerRegistry.subscribe, viewerRegistry.snapshot);
  const [query, setQuery] = useState('');
  const enabled = viewerRegistry.has('image-viewer');
  const installed = viewerRegistry.list();
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[85vh] overflow-auto">
    <DialogHeader><DialogTitle>Plugins</DialogTitle><DialogDescription>Manage optional file viewers in this browser. Text, PDF, audio and video previews remain available.</DialogDescription></DialogHeader>
    <Input aria-label="Find a plugin" placeholder="Find a plugin" value={query} onChange={event => setQuery(event.target.value)} />
    <h3 className="font-medium">Available plugins</h3>
    {'image viewer'.includes(query.toLowerCase()) ? <section aria-label="Image viewer" className="space-y-2 rounded border p-3">
      <h4 className="font-medium">Image viewer</h4><p className="text-sm">Preview images with zoom and keyboard controls.</p>
      <p className="text-xs text-muted-foreground">Built in · Trusted Canopy component · No editing</p>
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
