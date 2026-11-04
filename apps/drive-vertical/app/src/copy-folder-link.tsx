import { useEffect, useRef, useState } from 'react';
import { Button, Icon, Input } from '@canopy/ui';
import { currentSite, getFolder, listSites, ROOT_FOLDER_ID } from './api';
import { folderIdLink } from './folder-links';

/** Prepare the URL before the gesture: Safari requires clipboard writes during the click. */
export function CopyFolderLink({ folderId, compact = false, site }: { folderId: string; compact?: boolean; site?: string }) {
  const [ready, setReady] = useState<{ folderId: string; selection: string | null; url: string } | null>(null);
  const [lookupFailed, setLookupFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const ticket = ++generation.current;
    const selection = currentSite();
    setReady(null); setLookupFailed(false); setMessage(null); setBusy(false);
    void Promise.all([folderId === ROOT_FOLDER_ID ? Promise.resolve({ id: ROOT_FOLDER_ID }) : getFolder(folderId), (site || selection) ? Promise.resolve(site || selection!) : listSites().then(sites => {
      const slug = sites.find(site => site.current)?.slug;
      if (!slug) throw new Error('Current space unavailable');
      return slug;
    })]).then(([folder, slug]) => {
      if (generation.current === ticket && currentSite() === selection) setReady({ folderId, selection, url: folderIdLink(folder.id, slug) });
    }).catch(() => {
      if (generation.current === ticket) setLookupFailed(true);
    });
    return () => { generation.current++; };
  }, [folderId, retry, site]);
  const copy = () => {
    if (!ready || ready.folderId !== folderId || ready.selection !== currentSite() || busy) return;
    const ticket = generation.current;
    setBusy(true); setMessage(null);
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      // No awaited work before this call: retain the browser's user activation.
      void navigator.clipboard.writeText(ready.url).then(() => {
        if (generation.current === ticket) setMessage('Folder link copied.');
      }).catch(() => {
        if (generation.current === ticket) setMessage('Could not copy the link. Copy the address below instead.');
      }).finally(() => { if (generation.current === ticket) setBusy(false); });
    } catch {
      setBusy(false); setMessage('Could not copy the link. Copy the address below instead.');
    }
  };
  const unavailable = busy || !ready || ready.folderId !== folderId || ready.selection !== currentSite();
  if (compact) {
    // A tool in the folder header: an icon button, with any outcome in its tooltip and
    // a polite live region rather than paragraphs that push the header onto new rows.
    const failed = message?.startsWith('Could not copy');
    return <span className="inline-flex items-center gap-1">
      {lookupFailed
        ? <Button type="button" size="sm" variant="outline" className="gap-1.5" title="Could not look up the folder link. The folder may be unavailable or the connection may have failed." onClick={() => setRetry(value => value + 1)}>
            <Icon name="alert-triangle" size={14} /> <span className="hidden sm:inline">Retry folder lookup</span>
          </Button>
        : <Button type="button" variant="outline" size="sm" className="gap-1.5" aria-label="Copy folder link" title={ready?.url} disabled={unavailable} onClick={copy}>
            <Icon name="link" size={14} /> <span className="hidden sm:inline">{busy ? 'Copying…' : message === 'Folder link copied.' ? 'Copied' : 'Copy link'}</span>
          </Button>}
      {failed && ready ? <Input readOnly aria-label="Folder link" value={ready.url} className="h-8 w-56 text-xs" /> : null}
      <span role="status" className="sr-only">{message}</span>
    </span>;
  }
  return <section className="space-y-1">
    <Button type="button" variant="outline" size="sm" disabled={unavailable} onClick={copy}>{busy ? 'Copying…' : 'Copy folder link'}</Button>
    {lookupFailed ? <><p role="alert" className="text-sm">Could not look up the folder link. The folder may be unavailable or the connection may have failed.</p>
      <Button type="button" size="sm" variant="ghost" onClick={() => setRetry(value => value + 1)}>Retry folder lookup</Button></> : null}
    {ready ? <Input readOnly aria-label="Folder link" value={ready.url} className="h-8 text-xs" /> : null}
    <p className="text-xs text-muted-foreground">Only people who already have access can open this link. The address uses a stable folder ID and does not include folder names.</p>
    {message ? <p role="status" className="text-sm">{message}</p> : null}
  </section>;
}
