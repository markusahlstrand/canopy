import { useEffect, useRef, useState } from 'react';
import { Button, Icon, Input, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@canopy/ui';
import type { Site } from './api';
import { openSpace, spaceLink } from './space-navigation';
export function SpacesDialog({ open, onOpenChange, sites, failed, onRetry, canManage, offline = false, onMembers, onCreate, onSettings }: {
  open: boolean; onOpenChange: (open: boolean) => void; sites: Site[] | null; failed: boolean; onRetry: () => void;
  offline?: boolean; canManage: boolean; onMembers: () => void; onCreate?: () => void; onSettings?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  const copyAttempt = useRef(0);
  const copyLink = async (slug: string) => {
    const attempt = ++copyAttempt.current;
    const url = spaceLink(slug);
    try {
      await navigator.clipboard.writeText(url);
      if (copyAttempt.current === attempt) { setCopyMessage(`Copied link to ${slug}`); setCopyFallback(null); }
    } catch {
      if (copyAttempt.current === attempt) { setCopyMessage(`Could not copy link to ${slug}. Copy the address below instead.`); setCopyFallback(url); }
    }
  };
  useEffect(() => { copyAttempt.current++; if (open) { setQuery(''); setCopyMessage(''); setCopyFallback(null); } }, [open]);
  // The active space is context for the picker, even when the query matches another.
  const term = query.trim().toLocaleLowerCase();
  const matches = (site: Site) => `${site.name} ${site.slug}`.toLocaleLowerCase().includes(term);
  const shown = sites?.filter(site => site.current || matches(site))
    .sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
  const noOtherMatches = term !== '' && shown?.length && !sites?.some(site => !site.current && matches(site));
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[580px]">
    <DialogHeader className="px-5 pt-5"><DialogTitle>Spaces</DialogTitle><DialogDescription>Each space has its own files and members. Open one to browse its drive.</DialogDescription></DialogHeader>
    <div className="flex items-center gap-2 px-5 py-4">
      <Input aria-label="Find a space" placeholder="Find a space…" value={query} onChange={event => setQuery(event.target.value)} />
      {canManage && onCreate ? <Button className="shrink-0" disabled={offline} onClick={() => { onOpenChange(false); onCreate(); }}><Icon name="plus" size={16} /> Create space</Button> : null}
    </div>
    {copyMessage ? <p role="status" className="px-5 text-xs">{copyMessage}</p> : null}
    {copyFallback ? <div className="px-5 pb-2"><Input readOnly aria-label="Space link" value={copyFallback} onFocus={event => event.currentTarget.select()} /></div> : null}
    <div className="min-h-0 overflow-y-auto px-5 pb-5">
      {noOtherMatches && !failed ? <p role="status" className="mb-3 text-sm text-muted-foreground">No other spaces match “{query.trim()}”.</p> : null}
      {failed ? <div role="alert" className="mb-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{sites?.length ? 'Could not refresh spaces. Showing the last list.' : 'Could not load your spaces.'} <Button variant="outline" size="sm" disabled={offline} onClick={onRetry}>Retry spaces</Button></div> : null}
      {sites === null ? failed ? null : <p role="status" className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Loading spaces…</p>
        : sites.length === 0 ? failed ? null : <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{offline ? 'You have no saved spaces available. Reconnect to check spaces or create one.' : canManage ? 'You have no spaces available. Create a space to get started.' : 'You have no spaces available. Ask a space owner for an invitation.'}</p>
        : shown?.length === 0 ? <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No spaces match this search.</p>
        : <ul className="grid gap-3 sm:grid-cols-2">{shown?.map(site => <li key={site.slug} className="flex min-w-0 flex-col gap-3 rounded-lg border p-3.5">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg" style={{ color: site.color, backgroundColor: site.color ? `${site.color}1f` : undefined }}><Icon name={site.icon ?? 'folder'} size={20} /></span>
            <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-medium">{site.name}</h3><p className="truncate text-xs text-muted-foreground">{site.slug}</p></div>
            {site.current ? <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">Current space</span> : null}
          </div>
          <div className="mt-auto flex flex-wrap gap-1.5"><Button size="sm" variant={site.current ? 'secondary' : 'outline'} disabled={site.current || offline} onClick={() => openSpace(site.slug)}>Open {site.name}</Button>
            <Button size="sm" variant="ghost" onClick={() => void copyLink(site.slug)}>Copy link</Button>
            {site.current && canManage && !offline && onSettings ? <Button size="sm" variant="outline" onClick={() => { onOpenChange(false); onSettings(); }}>Space settings</Button> : null}
            {site.current && canManage && !offline ? <Button size="sm" variant="outline" onClick={() => { onOpenChange(false); onMembers(); }}>Manage members</Button> : null}</div>
        </li>)}</ul>}
    </div>
    <div className="border-t px-5 py-3"><Button size="sm" variant="ghost" onClick={onRetry}>Refresh spaces</Button></div>
  </DialogContent></Dialog>;
}
