import { FileMetadata } from './file-metadata';
import { TextPreview } from './text-preview';
import { confirmDiscardDrafts } from './drafts';
/**
 * File preview (S12a slice 3, #78) — lifted from the portal's `file-preview.tsx` and
 * cut down to what this vertical can actually answer.
 *
 * The preview exposes reads and writes backed by the scope operations: current
 * content, version history, keep/restore actions, descriptive metadata and extraction
 * status and comments. Processing logs still need their operation class ported.
 *
 * The image viewer is bundled as a trusted web component (#73). Other browser-native
 * types remain here until there is a first-party viewer that improves on them.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Icon, cn } from '@canopy/ui';
import type { FileViewerElement } from '@canopy/plugin-sdk/web-component';
import {
  contentUrl,
  versionContentUrl,
  fileBodyAsText,
  fileText,
  fileVersionsPage,
  getFile,
  restoreVersion,
  keepVersion,
  type DriveFile,
  type FileTextRow,
  type FileVersion,
} from './api';
import { TextEditor } from './text-editor';
import { useTextWrapPreference } from './text-wrap-preference';
import { CommentsPanel } from './comments';
import { FileDetailsPanel } from './file-details';
import { VersionComparison } from './version-comparison';
import { latestOnly } from './reads';
import { viewerRegistry, registerImageViewer } from './image-viewer';
import { FileLinkAction } from './copy-file-link';

registerImageViewer();

type Tab = 'file' | 'versions' | 'text' | 'details' | 'comments';

/** How a file's current version wants to be shown. */
type Shape = 'image' | 'viewer' | 'pdf' | 'text' | 'audio' | 'video' | 'none';

/**
 * What the browser can render without help, decided from the version's recorded mime —
 * which came from the stored bytes rather than from whatever the uploader claimed.
 */
export function shapeOf(mime: string | undefined, name = ''): Shape {
  mime = mime?.split(';')[0]!.trim().toLowerCase();
  // Native editing, PDF and media controls stay available even if a plugin claims them.
  if (mime?.startsWith('audio/')) return 'audio';
  if (mime?.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  if (mime?.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') return 'text';
  if (viewerRegistry.resolve({ mime: mime ?? '', name })) return 'viewer';
  if (mime?.startsWith('image/')) return 'image';
  return 'none';
}

/** Bytes, as a person reads them. */
export function humanSize(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** What the extraction row means, in the words a person would use. */
export function textStatusLabel(row: FileTextRow | null): string {
  if (!row) return 'Nobody has looked inside this file yet.';
  switch (row.status) {
    case 'indexed':
      return `${row.chars.toLocaleString()} characters, searchable.`;
    case 'empty':
      return 'Looked, and found no text — a scan or an image, most likely.';
    case 'unsupported':
      return 'Nothing here can read this kind of file yet.';
    case 'failed':
      return row.detail ? `Extraction failed: ${row.detail}` : 'Extraction failed.';
  }
}

/** Load the current file's metadata and render only the preview surfaces the API supports. */
export function PreviewPanel({
  fileId,
  onClose,
  onError,
  onChanged,
  navigation,
}: {
  fileId: string;
  onClose: () => void;
  onError: (message: string | null) => void;
  onChanged?: () => void;
  navigation?: { previous: string | null; next: string | null; moreAvailable?: boolean; onOpen: (id: string) => void };
}) {
  const [comparing, setComparing] = useState<{ selectedId: string; currentId: string } | null>(null);
  const [historyNext, setHistoryNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [canWrite, setCanWrite] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [editing, setEditing] = useState(false);
  const [wrapText, setWrapText] = useTextWrapPreference();
  const [tab, setTab] = useState<Tab>('file');
  const [file, setFile] = useState<DriveFile | null>(null);
  const [version, setVersion] = useState<FileVersion | null>(null);
  const [versions, setVersions] = useState<FileVersion[] | null>(null);
  const [extracted, setExtracted] = useState<FileTextRow | null | undefined>(undefined);
  const [body, setBody] = useState<{ text: string; truncated: boolean } | null>(null);

  /**
   * FOUR guards, one per independent read — not one for the panel.
   *
   * A single guard made the reads compete: opening Versions while `getFile` was still in
   * flight took the ticket, so the metadata answer was discarded as stale and the panel
   * sat claiming the file had no content. The guard exists to drop answers a NEWER ask
   * replaced, and these four do not replace each other — they are four different
   * questions about the same file, asked whenever the user happens to ask them.
   *
   * Each is one instance for the panel's life (a fresh one per render would make every
   * in-flight read current again, which is the race inverted), and all four are
   * invalidated together when `fileId` changes or the panel closes.
   */
  const meta = useRef(latestOnly()).current;
  const bodyReads = useRef(latestOnly()).current;
  const versionReads = useRef(latestOnly()).current;
  const textReads = useRef(latestOnly()).current;

  /**
   * Leaving this file — for another, or by closing — retires every pending answer.
   *
   * The cleanup runs on both, which is what makes one hook enough: without it a rejection
   * arriving after the panel closed would call `onError` and put an error on screen about
   * a file nobody is looking at.
   */
  useEffect(
    () => () => {
      meta.invalidate();
      bodyReads.invalidate();
      versionReads.invalidate();
      textReads.invalidate();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fileId],
  );

  /** The file and its current version: everything else hangs off the version's mime. */
  useEffect(() => {
    const ticket = meta.take();
    setEditing(false);
    setComparing(null);
    setTab('file');
    setFile(null);
    setCanWrite(false);
    setConfirmRestore(null);
    setRestoring(false);
    setVersion(null);
    setBody(null);
    setExtracted(undefined);
    setVersions(null);
    setHistoryNext(null);
    setLoadingMore(false);
    getFile(fileId)
      .then((got) => {
        if (!meta.current(ticket)) return;
        setFile(got.file);
        setVersion(got.version);
        setCanWrite(got.canWrite === true);
      })
      .catch((e: unknown) => {
        if (!meta.current(ticket)) return;
        onError(e instanceof Error ? e.message : String(e));
      });
    // The guards are stable for this panel; re-running on them would defeat them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, onError]);

  useSyncExternalStore(viewerRegistry.subscribe, viewerRegistry.snapshot);
  const shape = editing ? 'text' : shapeOf(version?.mime, file?.name);

  /** Text bodies are fetched, not linked — everything else the browser fetches itself. */
  useEffect(() => {
    if (tab !== 'file' || shape !== 'text' || !version) return;
    const ticket = bodyReads.take();
    fileBodyAsText(fileId, version.id)
      .then((got) => {
        if (bodyReads.current(ticket)) setBody(got);
      })
      .catch((e: unknown) => {
        if (bodyReads.current(ticket)) onError(e instanceof Error ? e.message : String(e));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, tab, shape, version?.id, onError]);

  const loadTab = useCallback(
    (next: Tab) => {
      if (next !== tab && !confirmDiscardDrafts()) return;
      setTab(next);
      if (next === 'versions' && versions === null) {
        const ticket = versionReads.take();
        fileVersionsPage(fileId)
          .then((got) => {
            if (versionReads.current(ticket)) { setVersions(got.versions); setHistoryNext(got.next); }
          })
          .catch((e: unknown) => {
            if (versionReads.current(ticket)) onError(e instanceof Error ? e.message : String(e));
          });
      }
      if (next === 'text' && extracted === undefined) {
        const ticket = textReads.take();
        fileText(fileId)
          .then((got) => {
            if (textReads.current(ticket)) setExtracted(got);
          })
          .catch((e: unknown) => {
            if (textReads.current(ticket)) onError(e instanceof Error ? e.message : String(e));
          });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fileId, versions, extracted, onError, tab],
  );

  const loadMore = async () => {
    if (!historyNext || loadingMore || restoring) return;
    const next = historyNext;
    const ticket = versionReads.take();
    setLoadingMore(true);
    try {
      const got = await fileVersionsPage(fileId, next);
      if (!versionReads.current(ticket)) return;
      if (got.next === next) throw new Error('Version history did not advance. Try refreshing.');
      setVersions((rows) => {
        const seen = new Set(rows?.map(row => row.id));
        return [...(rows ?? []), ...got.versions.filter(row => !seen.has(row.id))];
      });
      setHistoryNext(got.next);
    } catch (e: unknown) {
      if (versionReads.current(ticket)) onError(e instanceof Error ? e.message : String(e));
    } finally {
      if (versionReads.current(ticket)) setLoadingMore(false);
    }
  };

  const setKeep = async (versionId: string, keep: boolean) => {
    const ticket = versionReads.take();
    setRestoring(true);
    try {
      const changed = await keepVersion(fileId, versionId, keep);
      if (versionReads.current(ticket)) {
        setVersions((rows) => rows?.map((row) => row.id === changed.id ? changed : row) ?? null);
      }
    } catch (e: unknown) {
      if (versionReads.current(ticket)) onError(e instanceof Error ? e.message : String(e));
    } finally {
      if (versionReads.current(ticket)) setRestoring(false);
    }
  };

  const restore = async (versionId: string) => {
    const ticket = meta.take();
    const versionsTicket = versionReads.take();
    setRestoring(true);
    try {
      await restoreVersion(fileId, versionId);
      if (!meta.current(ticket)) return;
      // A restore changes HEAD, so every derived read must be retired as well.
      bodyReads.invalidate();
      textReads.invalidate();
      setBody(null);
      setExtracted(undefined);
      const [got, history] = await Promise.all([getFile(fileId), fileVersionsPage(fileId)]);
      if (!meta.current(ticket) || !versionReads.current(versionsTicket)) return;
      setFile(got.file);
      setVersion(got.version);
      setCanWrite(got.canWrite === true);
      setVersions(history.versions);
      setHistoryNext(history.next);
      setConfirmRestore(null);
      onChanged?.();
    } catch (e: unknown) {
      if (meta.current(ticket)) onError(e instanceof Error ? e.message : String(e));
    } finally {
      if (meta.current(ticket)) setRestoring(false);
    }
  };

  const reloadText = async () => {
    const ticket = meta.take();
    const got = await getFile(fileId);
    if (!meta.current(ticket)) return;
    bodyReads.invalidate(); textReads.invalidate(); versionReads.invalidate();
    setBody(null); setExtracted(undefined); setVersions(null); setHistoryNext(null);
    setFile(got.file); setVersion(got.version); setCanWrite(got.canWrite === true);
    setEditing(false); onChanged?.();
  };

  return (
    <aside
      aria-label="Preview"
      className="flex h-full w-full flex-col border-l border-border bg-background md:w-[28rem]"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="file-text" className="size-4 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{file?.name ?? 'Loading…'}</h2>
        {navigation ? <div className="flex gap-1" aria-label="File navigation">
          <Button variant="ghost" size="sm" disabled={!navigation.previous} aria-label="Previous file"
            onClick={() => { if (navigation.previous) navigation.onOpen(navigation.previous); }}><Icon name="chevron-left" className="size-4" /></Button>
          <Button variant="ghost" size="sm" disabled={!navigation.next} aria-label="Next file"
            title={!navigation.next && navigation.moreAvailable ? 'Load more files to continue' : undefined}
            onClick={() => { if (navigation.next) navigation.onOpen(navigation.next); }}><Icon name="chevron-right" className="size-4" /></Button>
        </div> : null}
        {version?.source === 'blob' ? (
          <Button variant="outline" size="sm" asChild>
            <a href={contentUrl(fileId)} download={file?.name}>
              <Icon name="download" className="size-4" />
              Download
            </a>
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close preview">
          <Icon name="x" className="size-4" />
        </Button>
      </header>

      {navigation?.moreAvailable && !navigation.next ? <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground" role="status">
        More files are available. Load more files in the listing to continue.
      </p> : null}
      <nav className="flex gap-1 border-b border-border px-2 py-1.5" aria-label="Preview sections">
        {(['file', 'versions', 'text', 'details', 'comments'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => loadTab(t)}
            className={cn(
              'rounded px-2 py-1 text-xs capitalize',
              tab === t ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60',
            )}
          >
            {t === 'file' ? 'Preview' : t === 'versions' ? 'Versions' : t === 'details' ? 'Details' : t === 'comments' ? 'Comments' : 'Text'}
          </button>
        ))}
      </nav>

      {file ? <FileLinkAction key={file.id} fileId={file.id} /> : null}

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === 'comments' ? <CommentsPanel key={fileId} fileId={fileId} /> : tab === 'details' ? <>{file ? <FileMetadata file={file} version={version} size={humanSize(version?.size)} canWrite={canWrite} /> : null}<FileDetailsPanel key={fileId} fileId={fileId} /></> : tab === 'file' ? (
          !version ? (
            <Empty>Nothing has been written to this file yet.</Empty>
          ) : shape === 'image' || shape === 'viewer' ? (
            <ImagePreview fileId={fileId} name={file?.name ?? ''} mime={version.mime} />
          ) : shape === 'audio' || shape === 'video' ? (
            version.source === 'blob' ? <MediaPreview key={`${fileId}:${version.id}`} fileId={fileId} versionId={version.id} name={file?.name ?? ''} shape={shape} />
              : <Empty>This version lives in a connected source; connector reads are not available.</Empty>
          ) : shape === 'pdf' ? (
            // `object` rather than `iframe`: it falls back to its children when the
            // browser has no PDF viewer, instead of rendering an empty frame.
            <object data={contentUrl(fileId)} type="application/pdf" className="h-full w-full">
              <Empty>
                This browser will not show the PDF inline. Download it instead.
              </Empty>
            </object>
          ) : shape === 'text' ? (
            body ? (
              editing ? <TextEditor key={`${fileId}:${version.id}`} fileId={fileId} versionId={version.id} text={body.text} wrap={wrapText}
                onSaved={reloadText} onReload={reloadText} onCancel={() => setEditing(false)} /> : <>
                {canWrite && !body.truncated && version.source === 'blob' ? <Button size="sm" variant="outline" className="mb-3" onClick={() => setEditing(true)}>Edit text</Button> : null}
                <TextPreview key={`${fileId}:${version.id}`} text={body.text} wrap={wrapText} onWrapChange={setWrapText} />
                {body.truncated ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Cut off here — download the file to read the rest.
                  </p>
                ) : null}
              </>
            ) : (
              <Empty>Loading…</Empty>
            )
          ) : (
            <Empty>
              No preview for {version.mime || 'this kind of file'}. Download it to open it.
            </Empty>
          )
        ) : tab === 'versions' ? (
          versions === null ? (
            <Empty>Loading…</Empty>
          ) : (
            <div className="space-y-3">
            {versions.length === 0 ? <Empty>No versions yet.</Empty> : null}
            <ul className="space-y-1.5 text-sm">
              {versions.map((v) => (
                <li key={v.id} className="flex flex-wrap items-baseline gap-2">
                  <span className="text-muted-foreground">{new Date(v.created_at).toLocaleString()}</span>
                  <span>{humanSize(v.size)}</span>
                  {v.id === version?.id ? (
                    <span className="rounded bg-muted px-1.5 text-xs">current</span>
                  ) : null}
                  {v.keep === 1 ? <span className="rounded bg-muted px-1.5 text-xs">kept</span> : null}
                  {canWrite ? (
                    <Button size="sm" variant="ghost" disabled={restoring || loadingMore} onClick={() => void setKeep(v.id, v.keep !== 1)}>
                      {v.keep === 1 ? 'Unkeep' : 'Keep'}
                    </Button>
                  ) : null}
                  {v.source === 'blob' && v.blob_ref ? (
                    <a
                      href={versionContentUrl(fileId, v.id)}
                      download={file?.name}
                      aria-label={`Download version from ${new Date(v.created_at).toLocaleString()}`}
                      className="ml-auto text-primary underline underline-offset-2"
                    >
                      Download
                    </a>
                  ) : null}
                  {canWrite && v.source === 'blob' && v.blob_ref && v.id !== version?.id ? (
                    confirmRestore === v.id ? (
                      <span className="flex flex-col gap-1">
                        <span className="text-xs">Make this content current as a new version?</span>
                        <Button size="sm" disabled={restoring || loadingMore} onClick={() => void restore(v.id)}>Confirm restore</Button>
                        <Button size="sm" variant="ghost" disabled={restoring || loadingMore} onClick={() => setConfirmRestore(null)}>Cancel</Button>
                      </span>
                    ) : (
                      <Button size="sm" variant="ghost" disabled={restoring || loadingMore} onClick={() => setConfirmRestore(v.id)}>Restore</Button>
                    )
                  ) : null}
                  {v.source === 'blob' && v.blob_ref && v.id !== version?.id && version?.source === 'blob' &&
                    shapeOf(v.mime) === 'text' && shapeOf(version.mime) === 'text' ? <Button size="sm" variant="ghost"
                      aria-label={`Compare version from ${new Date(v.created_at).toLocaleString()}`} onClick={() => setComparing({ selectedId: v.id, currentId: version.id })}>Compare text</Button> : null}
                  {v.source === 'external' ? (
                    <span className="text-xs text-muted-foreground">in a connected source</span>
                  ) : null}
                </li>
              ))}
            </ul>
            {comparing ? <VersionComparison key={`${fileId}:${comparing.selectedId}:${comparing.currentId}`} fileId={fileId}
              selectedId={comparing.selectedId} currentId={comparing.currentId} onClose={() => setComparing(null)} /> : null}
            {historyNext ? <Button variant="outline" size="sm" disabled={loadingMore || restoring} onClick={() => void loadMore()}>{loadingMore ? 'Loading older versions…' : 'Load older versions'}</Button> : null}
            </div>
          )
        ) : extracted === undefined ? (
          <Empty>Loading…</Empty>
        ) : (
          <div className="space-y-2 text-sm">
            <p>{textStatusLabel(extracted)}</p>
            {extracted && extracted.version_id !== version?.id ? (
              // The text describes a version the file has moved off. Saying so beats
              // showing a character count for content nobody can open any more.
              <p className="text-xs text-muted-foreground">
                This describes an older version — the file has been written to since.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  );
}

/** Mount the trusted web component and retire its file when this preview closes. */
function ImagePreview({ fileId, name, mime }: { fileId: string; name: string; mime: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useSyncExternalStore(viewerRegistry.subscribe, viewerRegistry.snapshot);
  const viewer = viewerRegistry.resolve({ mime, name });

  useEffect(() => {
    if (!viewer) { setFailed(true); return; }
    const element = document.createElement(viewer.tagName) as FileViewerElement;
    const onError = () => setFailed(true);
    setFailed(false);
    element.addEventListener('viewer-error', onError);
    element.file = { id: fileId, name, mime, contentUrl: contentUrl(fileId) };
    host.current?.append(element);
    return () => {
      element.file = null;
      element.removeEventListener('viewer-error', onError);
      element.remove();
    };
  }, [fileId, name, mime, viewer?.pluginId, viewer?.tagName]);

  return <>
    <div ref={host} className="h-full w-full" hidden={failed} />
    {failed ? <Empty>{viewer ? `Could not render ${name}.` : `No enabled viewer for ${name}. Enable image previews in File viewers, or download the file.`}</Empty> : null}
  </>;
}

/** Keep an empty or failed preview legible in the space used by the file body. */
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-8 text-center text-sm text-muted-foreground">{children}</p>;
}

/** No autoplay or eager download. Immutable version URLs keep playback pinned to HEAD at open. */
function MediaPreview({ fileId, versionId, name, shape }: { fileId: string; versionId: string; name: string; shape: 'audio' | 'video' }) {
  const [failed, setFailed] = useState(false);
  const player = useRef<HTMLMediaElement | null>(null);
  useEffect(() => {
    const media = player.current;
    return () => { if (media) { media.pause(); media.removeAttribute('src'); media.load(); } };
  }, [failed]);
  if (failed) return <Empty>This browser could not play {name}. <a href={versionContentUrl(fileId, versionId)} download={name} className="underline">Download this version</a> to open it.</Empty>;
  const props = { src: versionContentUrl(fileId, versionId), controls: true, preload: 'metadata', className: 'w-full',
    'aria-label': name, onError: () => setFailed(true), ref: (media: HTMLMediaElement | null) => { player.current = media; } };
  return shape === 'audio' ? <audio {...props} /> : <video {...props} playsInline />;
}
