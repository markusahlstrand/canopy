import { useState } from 'react';
import { Button, Input, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@canopy/ui';
import type { Site } from './api';
import { openSpace } from './space-navigation';
export function SpacesDialog({ open, onOpenChange, sites, failed, onRetry, canManage, onMembers, onCreate }: {
  open: boolean; onOpenChange: (open: boolean) => void; sites: Site[] | null; failed: boolean; onRetry: () => void;
  canManage: boolean; onMembers: () => void; onCreate?: () => void;
}) {
  const [query, setQuery] = useState('');
  const shown = sites?.filter(site => `${site.name} ${site.slug}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[85vh] overflow-auto">
    <DialogHeader><DialogTitle>Spaces</DialogTitle><DialogDescription>Each space has its own files and members. Open a space to browse its drive.</DialogDescription></DialogHeader>
    {canManage && onCreate ? <Button onClick={() => { onOpenChange(false); onCreate(); }}>Create space</Button> : null}
    <Input aria-label="Find a space" placeholder="Find a space" value={query} onChange={event => setQuery(event.target.value)} />
    {failed ? <div role="alert">Could not load your spaces. <Button variant="outline" onClick={onRetry}>Retry spaces</Button></div>
      : sites === null ? <p role="status">Loading spaces…</p> : sites.length === 0 ? <p>You have no spaces available. Ask a space owner for an invitation.</p>
      : shown?.length === 0 ? <p>No spaces match this search.</p> : <ul className="space-y-2">{shown?.map(site => <li key={site.slug} className="rounded border p-3">
        <h3 className="font-medium">{site.name} {site.current ? <span className="text-xs text-muted-foreground">Current space</span> : null}</h3>
        <p className="text-xs text-muted-foreground">{site.slug}</p>
        <div className="mt-2 flex gap-2"><Button size="sm" variant="outline" disabled={site.current} onClick={() => openSpace(site.slug)}>Open {site.name}</Button>
        {site.current && canManage ? <Button size="sm" variant="outline" onClick={() => { onOpenChange(false); onMembers(); }}>Manage members</Button> : null}</div>
      </li>)}</ul>}
    <Button variant="ghost" onClick={onRetry}>Refresh spaces</Button>
  </DialogContent></Dialog>;
}
