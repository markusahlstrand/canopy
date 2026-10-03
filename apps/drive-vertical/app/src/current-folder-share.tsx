import { useEffect, useState } from 'react';
import { Button } from '@canopy/ui';
import { getFolder, ROOT_FOLDER_ID } from './api';

/** A server permission decision, scoped to the folder that is actually on screen. */
export function CurrentFolderShare({ folderId, onShare }: {
  folderId: string; onShare: (folder: { id: string; name: string }) => void;
}) {
  const [folder, setFolder] = useState<Awaited<ReturnType<typeof getFolder>> | null>(null);
  useEffect(() => {
    let active = true;
    setFolder(null);
    if (folderId === ROOT_FOLDER_ID) return;
    void getFolder(folderId).then(value => { if (active) setFolder(value); }).catch(() => {});
    return () => { active = false; };
  }, [folderId]);
  if (folderId === ROOT_FOLDER_ID || folder?.id !== folderId || !folder.canManage) return null;
  return <Button variant="ghost" size="sm" onClick={() => onShare({ id: folder.id, name: folder.name || 'Folder' })}>Share this folder</Button>;
}
