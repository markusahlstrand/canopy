import { useEffect, useRef, useState } from 'react';
import { Button } from '@canopy/ui';
import { currentSite, getFolder } from './api';
import { folderLink } from './folder-links';

/** Copy navigation to an existing grant; this action never creates access. */
export function CopyFolderLink({ folderId }: { folderId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => { generation.current++; return () => { generation.current++; }; }, [folderId]);
  const copy = async () => {
    const ticket = generation.current;
    const site = currentSite();
    setBusy(true); setMessage(null);
    try {
      const folder = await getFolder(folderId);
      if (generation.current !== ticket || currentSite() !== site) return;
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(folderLink(folder.path, site));
      if (generation.current === ticket) setMessage('Folder link copied.');
    } catch {
      if (generation.current === ticket) setMessage('Could not copy the link. Allow clipboard access and try again.');
    } finally {
      if (generation.current === ticket) setBusy(false);
    }
  };
  return <section className="space-y-1">
    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void copy()}>{busy ? 'Copying…' : 'Copy folder link'}</Button>
    <p className="text-xs text-muted-foreground">Only people who already have access can open this link.</p>
    {message ? <p role="status" className="text-sm">{message}</p> : null}
  </section>;
}
