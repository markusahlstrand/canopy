import { useEffect, useMemo, useState } from 'react';
import { Button, Icon } from '@canopy/ui';
import { getOfflineVersion, type CachedVersion } from './offline-content';
import type { DriveFile } from './api';

/** Show a saved file without offering edits or fetching online content. */
export function OfflinePreview({ file, principal, space, onClose }: {
  file: DriveFile; principal: string; space: string; onClose: () => void;
}) {
  const [cached, setCached] = useState<CachedVersion | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setCached(null); setUrl(null); setLoading(true);
    if (!file.current_version_id) { setLoading(false); return; }
    void getOfflineVersion({ principal, space, fileId: file.id, versionId: file.current_version_id })
      .then(row => { if (active) setCached(row); })
      .catch(() => { if (active) setCached(null); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [file.id, file.current_version_id, principal, space]);
  useEffect(() => {
    if (!cached || typeof URL.createObjectURL !== 'function') return;
    const objectUrl = URL.createObjectURL(new Blob([cached.bytes], { type: cached.mime }));
    setUrl(objectUrl);
    return () => { URL.revokeObjectURL(objectUrl); setUrl(null); };
  }, [cached]);
  const text = useMemo(() => cached && (cached.mime.startsWith('text/') || /\b(json|xml|javascript)\b/.test(cached.mime))
    ? new TextDecoder().decode(cached.bytes) : null, [cached]);
  return <section className="flex h-full min-h-0 flex-col" aria-label={`Offline preview of ${file.name}`}>
    <header className="flex items-center gap-2 border-b p-3"><Icon name="file-text" size={18} /><strong className="min-w-0 flex-1 truncate">{file.name}</strong><Button size="sm" variant="outline" onClick={onClose}>Close</Button></header>
    {loading ? <p className="p-4 text-sm">Opening saved version…</p>
      : !cached ? <p role="status" className="p-4 text-sm">This file has no saved offline copy. Reconnect and mark its folder available offline.</p>
      : <>
        <p className="border-b px-4 py-2 text-xs text-muted-foreground">Read-only saved version from {new Date(cached.savedAt).toLocaleString()}</p>
        {text != null ? <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-4 text-sm">{text}</pre>
          : url && cached.mime.startsWith('image/') ? <img src={url} alt={file.name} className="min-h-0 flex-1 object-contain p-4" />
          : url && cached.mime === 'application/pdf' ? <iframe src={url} title={file.name} className="min-h-0 flex-1 border-0" />
          : <p className="min-h-0 flex-1 p-4 text-sm">Preview is unavailable for this file type. You can download the saved version.</p>}
        {url ? <a href={url} download={cached.name} className="m-4 inline-flex w-fit items-center rounded-md border px-3 py-2 text-sm">Download saved version</a> : null}
      </>}
  </section>;
}
