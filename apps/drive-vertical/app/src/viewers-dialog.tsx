import { useSyncExternalStore } from 'react';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@canopy/ui';
import { setImageViewerEnabled, viewerRegistry } from './image-viewer';

/** Only reviewed viewers bundled with this app are offered here. */
export function ViewersDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  useSyncExternalStore(viewerRegistry.subscribe, viewerRegistry.snapshot);
  const enabled = viewerRegistry.has('image-viewer');
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
    <DialogHeader><DialogTitle>File viewers</DialogTitle>
      <DialogDescription>Choose optional previews in this browser. Text, PDF, audio and video previews stay available.</DialogDescription>
    </DialogHeader>
    <section aria-label="Image viewer" className="flex items-center justify-between gap-4 rounded border p-3">
      <div><h3 className="font-medium">Image viewer</h3><p className="text-sm text-muted-foreground">Preview photos and images inline.</p>
        <p role="status" className="text-sm">{enabled ? 'Enabled' : 'Disabled'}</p></div>
      <Button size="sm" variant="outline" onClick={() => setImageViewerEnabled(!enabled)}>{enabled ? 'Disable image viewer' : 'Enable image viewer'}</Button>
    </section>
  </DialogContent></Dialog>;
}
