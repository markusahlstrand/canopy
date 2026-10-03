import { useEffect, useRef, useState } from 'react';
import { Button, Input } from '@canopy/ui';
import { currentSite, listSites } from './api';
import { fileLink } from './file-links';

/** Prepare the URL before the gesture: Safari requires clipboard writes during the click. */
export function CopyFileLink({ fileId }: { fileId: string }) {
  const [ready, setReady] = useState<{ fileId: string; selection: string | null; url: string } | null>(null);
  const [lookupFailed, setLookupFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const ticket = ++generation.current;
    const selection = currentSite();
    setReady(null); setLookupFailed(false); setMessage(null); setBusy(false);
    const slug = selection ? Promise.resolve(selection) : listSites().then(sites => {
      const slug = sites.find(site => site.current)?.slug;
      if (!slug) throw new Error('Current space unavailable');
      return slug;
    });
    void slug.then(slug => {
      if (generation.current === ticket && currentSite() === selection) setReady({ fileId, selection, url: fileLink(fileId, slug) });
    }).catch(() => {
      if (generation.current === ticket) setLookupFailed(true);
    });
    return () => { generation.current++; };
  }, [fileId, retry]);
  const copy = () => {
    if (!ready || ready.fileId !== fileId || ready.selection !== currentSite() || busy) return;
    const ticket = generation.current;
    setBusy(true); setMessage(null);
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      // No awaited work before this call: retain the browser's user activation.
      void navigator.clipboard.writeText(ready.url).then(() => {
        if (generation.current === ticket) setMessage('File link copied.');
      }).catch(() => {
        if (generation.current === ticket) setMessage('Could not copy the link. Copy the address below instead.');
      }).finally(() => { if (generation.current === ticket) setBusy(false); });
    } catch {
      setBusy(false); setMessage('Could not copy the link. Copy the address below instead.');
    }
  };
  return <section className="space-y-1">
    <Button type="button" variant="outline" size="sm" disabled={busy || !ready || ready.fileId !== fileId || ready.selection !== currentSite()} onClick={copy}>{busy ? 'Copying…' : 'Copy file link'}</Button>
    {lookupFailed ? <><p role="alert" className="text-sm">Could not look up the current space for this link. Check your connection and retry.</p>
      <Button type="button" size="sm" variant="ghost" onClick={() => setRetry(value => value + 1)}>Retry link lookup</Button></> : null}
    {ready ? <Input readOnly aria-label="File link" value={ready.url} className="h-8 text-xs" /> : null}
    <p className="text-xs text-muted-foreground">Only people who already have access can open this link. The address uses a stable file ID and does not include file names.</p>
    {message ? <p role="status" className="text-sm">{message}</p> : null}
  </section>;
}

/** Resolve the space only after opening the link panel; copy itself stays synchronous. */
export function FileLinkAction({ fileId }: { fileId: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [fileId]);
  return <div className="border-b border-border px-3 py-2">
    <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Hide file link' : 'File link'}</Button>
    {open ? <CopyFileLink key={fileId} fileId={fileId} /> : null}
  </div>;
}
