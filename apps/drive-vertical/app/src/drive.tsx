import { SpaceSettingsDialog } from './space-settings-dialog';
import { BulkRestore } from './bulk-restore';
import { BulkTrash } from './bulk-trash';
import { SearchMatchFilter, filterMatches, type MatchFilter } from './search-match-filter';
/**
 * The drive screen — the first of the portal's surfaces to run against the vertical
 * (S12, #64).
 *
 * Ported rather than reinvented: the layout, the row shape, the icon-by-kind and the
 * per-row action menu are the portal's, rebuilt on `@canopy/ui` because the portal's
 * own copies of those primitives live behind its `@/components/ui` alias. What is
 * deliberately NOT here is what the vertical cannot do yet — Move waits on the grant
 * decision (#75), and preview/viewers wait on the plugin seam (#73), so neither appears
 * as a menu item that does nothing.
 *
 * Folders and files are one list, folders first, because that is what a drive looks
 * like — but they are two reads and two entity types underneath, and the actions differ.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Icon, Input, Sheet, SheetContent, SheetTitle } from '@canopy/ui';
import { readViewPreferences, saveViewPreferences, watchViewPreferences } from './view-preferences';
import { latestOnly } from './reads';
import { confirmDiscardDrafts, hasUnsavedDrafts } from './drafts';
import { indexedMirror, syncMirror } from './scope-mirror';
import { watchDriveChanges } from './live-updates';
import { PreviewPanel } from './preview';
import { FileTable, type SortKey, type SortState } from './file-table';
import { Topbar } from './topbar';
import { SelectionSummary } from './selection-summary';
import { folderPath, linkedFolderId } from './folder-links';
import { linkedFileId } from './file-links';
import { CopyFolderLink } from './copy-folder-link';
import { Sidebar, useSites, type NavId } from './sidebar';
import { CreateSpaceDialog } from './create-space-dialog';
import { openSpace } from './space-navigation';
import { SpacesDialog } from './spaces-dialog';
import { PluginManagement } from './plugin-management';
import { SandboxPlugin } from './sandbox-plugin';
import { effectivePlugins, pluginManifest, refreshPlugins, useInstalledPlugins } from './installed-plugins';
import { PeopleDialog } from './people-dialog';
import { CurrentFolderShare } from './current-folder-share';
import { ShareDialog } from './share-dialog';
import { MoveDialog } from './move-dialog';
import { FileDropZone } from './file-drop-zone';
import { useUploadQueue } from './upload-queue';
import { CommandPalette } from './command-palette';
import type { Me } from './api';
import { kindOf, type FileItem } from './items';
import {
  ApiError,
  ROOT_FOLDER_ID,
  currentSite,
  SEARCH_MIN,
  contentUrl,
  peopleAccess,
  createFolder,
  folderByPath,
  getFolder,
  getFile,
  listFolderPage,
  listFoldersPage,
  appendRows,
  listSharedFolders,
  listTrashPage,
  moveFile,
  moveFolder,
  renameFile,
  renameFolder,
  restoreFile,
  search,
  trashFile,
  type DriveFile,
  type DriveFolder,
  type SearchHit,
} from './api';

/**
 * Every icon this screen asks for, named once.
 *
 * `Icon` renders a puzzle piece for a name it does not know — a silent fallback, which
 * is the right behaviour for a plugin-supplied name and a trap for ours. Listing them
 * here lets a test assert they all resolve, so a typo is a failure rather than a
 * puzzle piece somebody eventually notices.
 */
export const DRIVE_ICONS = [
  'folder',
  'file-text',
  'chevron-right',
  'trash',
  'plus',
  'upload',
  'more',
  'search',
  'grid',
  'list',
  // The topbar's, which this screen renders and so is answerable for.
  'refresh',
  'log-out',
  'panel-left',
  'chevron-left',
  'alert-triangle',
] as const;
export type IconName = (typeof DRIVE_ICONS)[number];

/**
 * The order the table displays, applied to the rows before they become items.
 *
 * The table reports a sort and renders what it is given — it does not sort itself, which
 * is a fact about the component that only a test surfaces. Folders always lead, because a
 * drive that interleaves them is a drive nobody can scan.
 */
function sorted<T extends { name: string; updated_at?: string }>(rows: T[], sort: SortState): T[] {
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) =>
    sort.key === 'modified'
      ? dir * (a.updated_at ?? '').localeCompare(b.updated_at ?? '')
      : dir * a.name.localeCompare(b.name),
  );
}

/** Bytes, as the table's `size` column wants them: already formatted, or an em dash. */
function sizeLabel(bytes: number | null | undefined): string {
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

const folderItem = (folder: DriveFolder): FileItem => ({
  id: folder.id,
  name: folder.name,
  kind: 'folder',
  modified: '—',
  size: '—',
  isFolder: true,
  path: folder.path,
});

const fileItem = (file: DriveFile, mime?: string | null): FileItem => ({
  id: file.id,
  name: file.name,
  // The kind is a presentation fact derived from the version's mime; a listing does not
  // carry versions, so an unwritten file reads as a plain document until it is opened.
  kind: file.current_version_id ? kindOf(mime) : 'doc',
  modified: file.current_version_id ? when(file.updated_at) : 'No content yet',
  size: '—',
  isFolder: false,
});

/** A breadcrumb: the trail back to the root, built from the folder's own path. */
interface Crumb {
  id: string;
  name: string;
}

export interface DriveScreenProps {
  onError: (message: string | null) => void;
  /** The shell's account menu lives in the topbar, which this screen renders. */
  auth: Me;
  onSignIn: () => void;
  onSignOut: () => void;
}

export function DriveScreen({ onError, auth, onSignIn, onSignOut }: DriveScreenProps) {
  const initialFileId = useRef(linkedFileId()).current;
  const initialPath = useRef(folderPath()).current;
  const initialFolderId = useRef(linkedFolderId()).current;
  const [linkPending, setLinkPending] = useState(!!initialFileId || !!initialFolderId || !!initialPath);
  const [linkMessage, setLinkMessage] = useState<string | null>(null);
  const skipLinkedListing = useRef(false);
  const linkNavigation = useRef(0);
  const [folderRecovery, setFolderRecovery] = useState(0);
  const unavailableFolder = useRef<string | null>(null);
  const [linkListingUnavailable, setLinkListingUnavailable] = useState(false);
  const [folderId, setFolderId] = useState(ROOT_FOLDER_ID);
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [trashNext, setTrashNext] = useState<string | null>(null);
  const [filesNext, setFilesNext] = useState<string | null>(null);
  const [foldersNext, setFoldersNext] = useState<string | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [busy, setBusy] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [offline, setOffline] = useState(false);
  const [view, setView] = useState<'drive' | 'trash' | 'search' | 'shared'>('drive');
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [matchFilter, setMatchFilter] = useState<MatchFilter>('all');
  const visibleHits = filterMatches(hits, matchFilter);
  const [trash, setTrash] = useState<DriveFile[]>([]);
  const [renaming, setRenaming] = useState<{ kind: 'file' | 'folder'; id: string; name: string } | null>(null);
  const [moving, setMoving] = useState<FileItem[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [previewing, changePreview] = useState<string | null>(null);
  const previewId = useRef(previewing);
  previewId.current = previewing;
  const setPreviewing = useCallback((id: string | null) => {
    if (id !== previewId.current && !confirmDiscardDrafts()) return false;
    changePreview(id);
    return true;
  }, []);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [spaceSettingsOpen, setSpaceSettingsOpen] = useState(false);
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false);
  const [spacesOpen, setSpacesOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [viewersOpen, setViewersOpen] = useState(false);
  const [activePluginId, setActivePluginId] = useState<string | null>(null);
  const exitPluginApp = useCallback(() => {
    if (activePluginId && !confirmDiscardDrafts()) return false;
    setActivePluginId(null);
    return true;
  }, [activePluginId]);
  const installedPlugins = useInstalledPlugins();
  const pluginApps = effectivePlugins(installedPlugins).filter(row => row.enabled === 1 && !!pluginManifest(row).contributes.detailView);
  const activePlugin = pluginApps.find(row => row.id === activePluginId);
  /** The folder whose sharing is open. Null is closed — one dialog, one folder at a time. */
  const [sharing, setSharing] = useState<{ id: string; name: string } | null>(null);
  /**
   * Whether this login administers the people here — asked once, on mount.
   *
   * A boolean from the server rather than a role name read off the session: the answer is
   * a permission decision, and the operation that makes it is the same one the invite
   * routes gate on, so the menu cannot offer what the routes would refuse.
   */
  const [canManagePeople, setCanManagePeople] = useState(false);
  const siteList = useSites();
  useEffect(() => { void refreshPlugins().catch(() => {}); }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete('path');
    url.searchParams.delete('folder');
    url.searchParams.delete('file');
    window.history.replaceState(null, '', url);
    if (!initialFileId && !initialFolderId && !initialPath) return;
    let active = true;
    const generation = linkNavigation.current;
    // A file link opens the permission-checked preview without requiring ancestor access.
    const resolve = async () => {
      if (initialFileId) {
        const { file } = await getFile(initialFileId);
        if (!active || generation !== linkNavigation.current) return;
        changePreview(file.id);
        try {
          const folder = await getFolder(file.folder_id);
          if (!active || generation !== linkNavigation.current) return;
          setFolderId(folder.id);
          setCrumbs(folder.id === ROOT_FOLDER_ID ? [] : [{ id: folder.id, name: folder.path }]);
        } catch {
          if (active && generation === linkNavigation.current) { unavailableFolder.current = file.folder_id; skipLinkedListing.current = true; setLinkListingUnavailable(true); setLinkMessage('The file is open, but its folder could not be loaded.'); }
        }
      } else {
        const folder = await (initialFolderId ? getFolder(initialFolderId) : folderByPath(initialPath));
        if (!active || generation !== linkNavigation.current) return;
        if (folder) { setFolderId(folder.id); setCrumbs(folder.id === ROOT_FOLDER_ID ? [] : [{ id: folder.id, name: folder.path }]); }
        else setLinkMessage('This folder is unavailable or you do not have access.');
      }
    };
    void resolve().catch((error: unknown) => {
      const subject = initialFileId ? 'file' : 'folder';
      if (active && generation === linkNavigation.current) setLinkMessage(error instanceof ApiError && [401, 403, 404].includes(error.status)
        ? `This ${subject} is unavailable or you do not have access.`
        : `Could not open the ${subject} link. Reload to retry.`);
    }).finally(() => { if (active) setLinkPending(false); });
    return () => { active = false; };
  }, [initialFileId, initialFolderId, initialPath]);

  useEffect(() => { setLinkMessage(null); }, [folderId, view]);

  useEffect(() => {
    if (!mobileNavOpen || !window.matchMedia) return;
    const desktop = window.matchMedia('(min-width: 768px)');
    const closeOnDesktop = () => { if (desktop.matches) setMobileNavOpen(false); };
    desktop.addEventListener('change', closeOnDesktop);
    closeOnDesktop();
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, [mobileNavOpen]);
  /** The topbar's Upload button and the palette's action both reach the one file input. */
  const uploadRef = useRef<HTMLInputElement>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [savedView] = useState(readViewPreferences);
  const [layout, setLayout] = useState<'list' | 'grid'>(savedView.layout);
  const [sort, setSort] = useState<SortState>(savedView.sort);
  // Only files already loaded in the active listing participate. Match its sort
  // order, and use the same draft boundary as table and palette navigation.
  const previewFiles = offline ? [] : view === 'drive' ? sorted(files, sort) : view === 'search' ? sorted(visibleHits, sort) : [];
  const previewIndex = previewFiles.findIndex(file => file.id === previewing);
  const previewNavigation = previewIndex < 0 ? undefined : {
    previous: previewFiles[previewIndex - 1]?.id ?? null,
    next: previewFiles[previewIndex + 1]?.id ?? null,
    moreAvailable: view === 'drive' && filesNext !== null,
    onOpen: (id: string) => { setPreviewing(id); },
  };
  const reads = useRef(latestOnly());
  /**
   * The CURRENT refresh, not the one an action closed over.
   *
   * An action started in folder A resolves after the user has opened folder B. Calling
   * the refresh it captured would read folder A — and, worse, claim the screen's ticket
   * while doing it, so folder B's own read could no longer correct the result. A ref
   * keeps "refresh what is on screen" true at the moment it is called.
   */
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => watchViewPreferences(value => {
    setLayout(value.layout);
    setSort(value.sort);
  }), []);
  const uploads = useUploadQueue(() => refreshRef.current());

  const changeMatchFilter = (value: MatchFilter) => { reads.current.invalidate(); setMatchFilter(value); setSelection(new Set()); setBusy(true); };

  /** One refresh for both views, so an action never leaves half the screen stale. */
  const refresh = useCallback(async (retryFolder = false) => {
    if (linkPending) return;
    if (skipLinkedListing.current && view === 'drive') {
      if (!retryFolder || !unavailableFolder.current) { setBusy(false); return; }
      const generation = linkNavigation.current;
      setBusy(true);
      try {
        const folder = await getFolder(unavailableFolder.current);
        if (generation !== linkNavigation.current) return;
        skipLinkedListing.current = false;
        setLinkListingUnavailable(false);
        setLinkMessage(null);
        setFolderRecovery(value => value + 1);
        setFolderId(folder.id);
        setCrumbs(folder.id === ROOT_FOLDER_ID ? [] : [{ id: folder.id, name: folder.path }]);
        // The state update schedules the listing refresh for the recovered folder.
      } catch { /* Keep the preview and the explicit retry action available. */ }
      finally { if (generation === linkNavigation.current) setBusy(false); }
      return;
    }
    const ticket = reads.current.take();
    setBusy(true);
    setLoadingPage(false);
    setFoldersNext(null);
    setFilesNext(null);
    setTrashNext(null);
    setLoadFailed(false);
    try {
      if (view === 'search') {
        // Below the floor there is nothing to ask for, and asking would be a 400.
        const q = term.trim();
        const found = q.length >= SEARCH_MIN ? (await search(q, 50, matchFilter === 'all' ? undefined : matchFilter)).hits : [];
        // Checked AFTER the await, every time: an answer that arrives for a term the
        // box no longer holds is stale, and writing it is how a search shows results
        // for what you typed a moment ago.
        if (!reads.current.current(ticket)) return;
        setHits(found);
      } else if (view === 'shared') {
        const shared = await listSharedFolders();
        if (!reads.current.current(ticket)) return;
        setFolders(shared.folders);
        setFiles([]);
      } else if (view === 'trash') {
        const bin = await listTrashPage();
        if (!reads.current.current(ticket)) return;
        setTrash(bin.entries);
        setTrashNext(bin.next);
      } else {
        const [subfolders, contents] = await Promise.all([listFoldersPage(folderId), listFolderPage(folderId)]);
        if (!reads.current.current(ticket)) return;
        setFolders(subfolders.entries);
        setFoldersNext(subfolders.next);
        setFiles(contents.entries);
        setFilesNext(contents.next);
        // The online listing stays the hot path. The spine feed updates the offline
        // metadata mirror in the background; a failed cache write cannot fail a read.
        if (auth.principal) void syncMirror(auth.principal).catch(() => {});
      }
      setOffline(false);
      setLoadFailed(false);
      onError(null);
    } catch (e: unknown) {
      // A stale failure is as misleading as a stale answer: the folder it belonged to
      // is not the one on screen.
      if (!reads.current.current(ticket)) return;
      if (view === 'drive' && auth.principal &&
          (e instanceof TypeError || (e instanceof ApiError && e.status >= 500))) {
        try {
          const saved = await indexedMirror.folder(auth.principal, folderId);
          if (!reads.current.current(ticket)) return;
          if (saved) {
            setFolders(saved.folders);
            setFiles(saved.files);
            if (!hasUnsavedDrafts()) changePreview(null);
            setCmdOpen(false);
            setOffline(true);
            setLoadFailed(false);
            onError(null);
            return;
          }
        } catch {
          // IndexedDB can be unavailable; surface the original network failure.
        }
      }
      setLoadFailed(true);
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      if (reads.current.current(ticket)) setBusy(false);
    }
  }, [folderId, view, term, matchFilter, onError, auth.principal, linkPending]);

  const moreTrash = async () => {
    if (!trashNext || busy || loadingPage || offline) return;
    const ticket = reads.current.take();
    setLoadingPage(true);
    onError(null);
    try {
      const page = await listTrashPage(trashNext);
      if (!reads.current.current(ticket)) return;
      setTrash(rows => appendRows(rows, page.entries));
      setTrashNext(page.next);
    } catch (e: unknown) {
      if (reads.current.current(ticket)) onError(e instanceof Error ? e.message : String(e));
    } finally {
      if (reads.current.current(ticket)) setLoadingPage(false);
    }
  };

  const moreFiles = async () => {
    if (!filesNext || busy || loadingPage || offline) return;
    const ticket = reads.current.take();
    setLoadingPage(true);
    onError(null);
    try {
      const page = await listFolderPage(folderId, filesNext);
      if (!reads.current.current(ticket)) return;
      setFiles(rows => appendRows(rows, page.entries));
      setFilesNext(page.next);
    } catch (e: unknown) {
      if (reads.current.current(ticket)) onError(e instanceof Error ? e.message : String(e));
    } finally {
      if (reads.current.current(ticket)) setLoadingPage(false);
    }
  };

  const moreFolders = async () => {
    if (!foldersNext || busy || loadingPage || offline) return;
    const ticket = reads.current.take();
    setLoadingPage(true);
    onError(null);
    try {
      const page = await listFoldersPage(folderId, foldersNext);
      if (!reads.current.current(ticket)) return;
      setFolders(rows => appendRows(rows, page.entries));
      setFoldersNext(page.next);
      onError(null);
    } catch (e: unknown) {
      if (reads.current.current(ticket)) onError(e instanceof Error ? e.message : String(e));
    } finally {
      if (reads.current.current(ticket)) setLoadingPage(false);
    }
  };

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    const principal = auth.principal;
    if (!principal) return;
    let active = true;
    let refreshing = false;
    let pending = false;
    const refreshLive = async () => {
      if (!active) return;
      if (refreshing) {
        pending = true;
        return;
      }
      refreshing = true;
      try {
        do {
          pending = false;
          void syncMirror(principal).catch(() => {});
          await refreshRef.current();
          // Use the current view for the trailing read; navigation still owns its tickets.
        } while (active && pending);
      } finally {
        refreshing = false;
      }
    };
    const stop = watchDriveChanges(() => { void refreshLive(); });
    return () => {
      active = false;
      stop();
    };
  }, [auth.principal]);

  useEffect(() => {
    // A failure is an answer here: no menu item. It is not worth the shell's banner —
    // nothing the person was trying to do has failed.
    peopleAccess()
      .then(({ canManage }) => setCanManagePeople(canManage))
      .catch(() => setCanManagePeople(false));
  }, []);

  /** ⌘K / Ctrl-K opens the palette — the shortcut the portal had, and the reason it exists. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (offline) return;
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setCmdOpen((was) => !was);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [offline]);

  useEffect(() => {
    // A pause, not a keystroke: the index is per scope and cheap, but a request per
    // character still races its own answers and the last one to land wins.
    if (linkPending) return;
    if (skipLinkedListing.current && view === 'drive') { setBusy(false); return; }
    const t = setTimeout(() => void refresh(), view === 'search' ? 200 : 0);
    return () => clearTimeout(t);
  }, [refresh, view, linkPending, folderRecovery]);

  /**
   * Switching view, from the rail or from the palette.
   *
   * One function for both, because "go to My Drive" has to mean the same thing however
   * it was asked: back to the ROOT of the drive, not to whichever folder the trail
   * happened to be in when you left for the trash. The palette used to only set the
   * view, so its My Drive left you looking at a subfolder labelled as the root.
   */
  const navigate = useCallback((id: NavId): boolean => {
    if (window.matchMedia?.('(max-width: 767px)').matches && !setPreviewing(null)) return false;
    if (!exitPluginApp()) return false;
    linkNavigation.current++;
    setLinkPending(false);
    if (skipLinkedListing.current) setFolderRecovery(value => value + 1);
    skipLinkedListing.current = false;
    setLinkListingUnavailable(false);
    const alreadyHere = !linkListingUnavailable && (id !== 'drive'
      ? view === id
      : view === 'drive' && folderId === ROOT_FOLDER_ID);
    if (alreadyHere) {
      void refreshRef.current();
      return true;
    }
    // Whatever is in flight belongs to the view being left.
    reads.current.invalidate();
    setTerm('');
    setMatchFilter('all');
    setHits([]);
    setSelection(new Set());
    setBusy(true);
    if (id === 'trash') {
      setView('trash');
      return true;
    }
    setCrumbs([]);
    setFolderId(ROOT_FOLDER_ID);
    if (id === 'shared') {
      setFolders([]);
      setFiles([]);
    }
    setView(id);
    return true;
  }, [exitPluginApp, folderId, view, linkListingUnavailable, setPreviewing]);

  const open = (folder: DriveFolder) => {
    // The listing on screen belongs to the folder being left; nothing in flight for it
    // may land here.
    if (window.matchMedia?.('(max-width: 767px)').matches && !setPreviewing(null)) return;
    linkNavigation.current++;
    setLinkPending(false);
    if (skipLinkedListing.current) setFolderRecovery(value => value + 1);
    skipLinkedListing.current = false;
    setLinkListingUnavailable(false);
    reads.current.invalidate();
    setSelection(new Set());
    if (view === 'shared') {
      setView('drive');
      setCrumbs([{ id: folder.id, name: folder.path }]);
      setFolderId(folder.id);
      return;
    }
    setCrumbs((c) => [...c, { id: folder.id, name: folder.name }]);
    setFolderId(folder.id);
  };

  const upTo = (index: number) => {
    if (window.matchMedia?.('(max-width: 767px)').matches && !setPreviewing(null)) return;
    linkNavigation.current++;
    setLinkPending(false);
    if (skipLinkedListing.current) setFolderRecovery(value => value + 1);
    skipLinkedListing.current = false;
    setLinkListingUnavailable(false);
    reads.current.invalidate();
    setSelection(new Set());
    // -1 is the root: the crumb trail holds everything below it.
    setCrumbs((c) => c.slice(0, index + 1));
    setFolderId(index < 0 ? ROOT_FOLDER_ID : crumbs[index]!.id);
  };

  const act = async (fn: () => Promise<unknown>) => {
    if (offline) return;
    try {
      await fn();
      // Through the ref: whatever the screen shows NOW, which may not be where this
      // action started.
      await refreshRef.current();
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Clicking a column header: same key toggles direction, a new key starts ascending. */
  const onSort = (key: SortKey) => {
    const next: SortState = { key, dir: sort.key === key && sort.dir === 'asc' ? 'desc' : 'asc' };
    setSort(next);
    saveViewPreferences({ layout, sort: next });
  };

  /**
   * The table emits action names; this is where they become operations.
   *
   * Only the ones that exist: the table's own menu offers Rename, Move, Delete and Download,
   * and anything it would offer without an operation behind it was removed when the
   * component moved rather than wired to nothing here.
   */
  const onAction = (action: string, item: FileItem) => {
    if (offline && (action !== 'Open' || !item.isFolder)) return;
    if (action === 'Open') {
      const folder = folders.find((f) => f.id === item.id);
      if (folder) open(folder);
      else setPreviewing(item.id);
      return;
    }
    if (action === 'Share') {
      // Folders only, and the table only offers it for folders — but an action name is a
      // string, and a file id handed to `list-folder-shares` is a 404 rather than a refusal.
      if (item.isFolder) setSharing({ id: item.id, name: item.name });
      return;
    }
    if (action === 'Rename') {
      setRenaming({ kind: item.isFolder ? 'folder' : 'file', id: item.id, name: item.name });
      return;
    }
    if (action === 'Delete') {
      if (!item.isFolder) void act(() => trashFile(item.id));
      return;
    }
    if (action === 'Restore') {
      void act(() => restoreFile(item.id));
      return;
    }
    if (action === 'Download' && !item.isFolder) {
      window.open(contentUrl(item.id), '_blank', 'noopener');
      return;
    }
    if (action === 'Move') {
      const visible = view === 'search' ? visibleHits.map((hit) => fileItem(hit))
        : [...folders.map(folderItem), ...files.map((file) => fileItem(file))];
      setMoving(selection.has(item.id) ? visible.filter((row) => selection.has(row.id)) : [item]);
    }
  };

  /**
   * Creating and uploading are things you do IN the drive, so they take you there first.
   *
   * Both write into `folderId`, and the trash and search views keep whatever folder you
   * were last in. Pressing New folder while looking at the trash therefore wrote into a
   * folder that was not on screen, and the refresh afterwards reloaded the trash — so the
   * write succeeded, invisibly, somewhere else. Going to My Drive first makes the
   * destination the thing you are looking at, which is the only version of this a person
   * can predict. `navigate` also resets the folder to the root, and the handlers below
   * read `folderId` when they run rather than when they were wired, so the write lands
   * where the screen now is.
   */
  const startWrite = (begin: () => void) => {
    if (offline || linkPending || linkListingUnavailable) return;
    if (view !== 'drive') {
      if (!navigate('drive')) return;
    } else if (!exitPluginApp()) return;
    begin();
  };

  const onUpload = (input: HTMLInputElement) => {
    const chosen = Array.from(input.files ?? []);
    input.value = '';
    if (chosen.length === 0) return;
    if (!offline && !linkPending && !linkListingUnavailable) uploads.enqueue(folderId, [siteList.sites?.find(site => site.current)?.name ?? currentSite() ?? 'This space', ...crumbs.map(crumb => crumb.name)].join('/'), chosen);
  };

  const empty = linkListingUnavailable && view === 'drive' ? (
    <EmptyList icon="folder" title="Folder context unavailable" description="The file preview remains available. Choose My Drive to browse folders you can access." actions={[{ label: 'Retry folder', onClick: () => void refresh(true) }, { label: 'Go to My Drive', onClick: () => navigate('drive') }]} />
  ) : loadFailed ? (
    <EmptyList icon="alert-triangle" title="Couldn't load this view" description="Check the connection and try again."
      actions={[{ label: 'Try again', onClick: () => void refresh() }]} />
  ) : view === 'trash' ? (
    <EmptyList icon="trash" title={trashNext ? "No files on this page" : "Trash is empty"} description={trashNext ? "Load more to continue checking Trash." : "Deleted files will appear here."} />
  ) : view === 'shared' ? (
    <EmptyList icon="folder" title="No folders shared with you" description="Direct folder grants in this space will appear here." />
  ) : view === 'search' ? (
    term.trim().length < SEARCH_MIN
      ? <EmptyList icon="search" title="Search this space" description={`Enter at least ${SEARCH_MIN} characters to find files.`} />
      : matchFilter !== 'all' && visibleHits.length === 0
        ? <EmptyList icon="search" title="No matches of this type" description="Try another match type. The selected field is searched directly, returning up to 50 files." actions={[{ label: 'Show all returned matches', onClick: () => changeMatchFilter('all') }]} />
        : <EmptyList icon="search" title={`No matches for “${term.trim()}”`} description="Try another name or phrase from a file." />
  ) : offline ? (
    <EmptyList icon="folder" title="No saved files here" description="This folder has no file names saved for offline browsing." />
  ) : (
    <EmptyList
      icon="folder"
      title={folderId === ROOT_FOLDER_ID ? 'Your drive is empty' : 'This folder is empty'}
      description="Create a folder or upload files to get started."
      actions={[
        { label: 'New folder', onClick: () => setCreating(true) },
        { label: 'Upload files', onClick: () => uploadRef.current?.click() },
      ]}
    />
  );

  return (
    <div className="flex min-h-0 flex-1">
      <div className="hidden md:block">
        <Sidebar
          active={activePluginId ? null : view}
          onNavigate={navigate}
          onNewFolder={() => startWrite(() => setCreating(true))}
          onUpload={() => startWrite(() => uploadRef.current?.click())}
          offline={offline}
          sites={siteList.sites}
          failed={siteList.failed}
          onSpaces={() => setSpacesOpen(true)}
          pluginApps={pluginApps}
          activePluginId={activePluginId}
          onOpenPlugin={id => { if (!confirmDiscardDrafts()) return; changePreview(null); setActivePluginId(id); }}
          onCreateSpace={canManagePeople && !offline ? () => setCreateSpaceOpen(true) : undefined}
          canManageSpace={canManagePeople}
          onSpaceSettings={() => setSpaceSettingsOpen(true)}
          onSpaceMembers={() => setPeopleOpen(true)}
          onSpacePlugins={() => setViewersOpen(true)}
          onRetry={siteList.retry}
        />
      </div>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" showCloseButton className="w-[min(20rem,85vw)] gap-0 p-0 md:hidden">
          <SheetTitle className="sr-only">Drive navigation</SheetTitle>
          <Sidebar
            mobile
            active={activePluginId ? null : view}
            onNavigate={(id) => { if (navigate(id)) setMobileNavOpen(false); }}
            onNewFolder={() => { setMobileNavOpen(false); startWrite(() => setCreating(true)); }}
            onUpload={() => { setMobileNavOpen(false); startWrite(() => uploadRef.current?.click()); }}
            offline={offline}
            sites={siteList.sites}
            failed={siteList.failed}
            onSpaces={() => { setMobileNavOpen(false); setSpacesOpen(true); }}
            pluginApps={pluginApps}
            activePluginId={activePluginId}
            onOpenPlugin={id => { if (!confirmDiscardDrafts()) return; changePreview(null); setActivePluginId(id); setMobileNavOpen(false); }}
            onCreateSpace={canManagePeople && !offline ? () => { setMobileNavOpen(false); setCreateSpaceOpen(true); } : undefined}
            canManageSpace={canManagePeople}
            onSpaceSettings={() => { setMobileNavOpen(false); setSpaceSettingsOpen(true); }}
            onSpaceMembers={() => { setMobileNavOpen(false); setPeopleOpen(true); }}
            onSpacePlugins={() => { setMobileNavOpen(false); setViewersOpen(true); }}
            onRetry={siteList.retry}
          />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
      <Topbar
        breadcrumb={activePlugin ? [pluginManifest(activePlugin).name] : view === 'trash' ? ['Trash'] : view === 'search' ? ['Search'] : view === 'shared' ? ['Shared with me'] : ['My Drive', ...crumbs.map((c) => c.name)]}
        spaceName={siteList.sites?.find(site => site.current)?.name}
        onOpenSpaces={() => setSpacesOpen(true)}
        // The topbar counts the root as crumb 0; `upTo` counts it as -1.
        onCrumbClick={view === 'drive' ? (index) => upTo(index - 1) : undefined}
        onOpenMenu={() => setMobileNavOpen(true)}
        onOpenCmd={() => setCmdOpen(true)}
        onUpload={() => startWrite(() => uploadRef.current?.click())}
        onRefresh={() => void refresh(true)}
        syncing={busy}
        onOpenViewers={() => setViewersOpen(true)}
        onOpenPeople={canManagePeople && !offline ? () => setPeopleOpen(true) : undefined}
        offline={offline}
        auth={auth}
        onSignIn={onSignIn}
        onSignOut={onSignOut}
      />

      {linkMessage ? <p role="status" className="px-4 py-2 text-sm">{linkMessage}</p> : null}
      {!activePluginId && view === 'drive' && !offline && !linkPending && !linkListingUnavailable ? <div className="flex flex-wrap gap-2 px-4 py-2">
        <CurrentFolderShare folderId={folderId} onShare={setSharing} />
        {siteList.sites?.find(site => site.current)?.slug || currentSite() ? <CopyFolderLink key={folderId} folderId={folderId}
          site={siteList.sites?.find(site => site.current)?.slug ?? currentSite() ?? undefined} compact /> : null}
      </div> : null}

      <input
        ref={uploadRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => onUpload(e.currentTarget)}
      />

      {uploads.panel}

      <CommandPalette
        open={cmdOpen}
        onOpenChange={setCmdOpen}
        files={[...folders.map(folderItem), ...files.map((file) => fileItem(file))]}
        sites={siteList.sites ?? []}
        onOpenSpace={offline ? undefined : openSpace}
        pluginApps={pluginApps}
        onOpenPlugin={id => { if (!confirmDiscardDrafts()) return; changePreview(null); setActivePluginId(id); }}
        onManageSpaces={() => setSpacesOpen(true)}
        onManagePlugins={() => setViewersOpen(true)}
        onNavigate={(id) => navigate(id === 'trash' ? 'trash' : id === 'shared' ? 'shared' : id === 'search' ? 'search' : 'drive')}
        onOpenFile={(item) => {
          // The palette lists folders too, and a folder is entered rather than previewed —
          // the panel would open on an id `get-file` cannot resolve.
          const folder = folders.find((f) => f.id === item.id);
          if (folder) {
            if (exitPluginApp()) open(folder);
          } else if (activePluginId) {
            if (exitPluginApp()) changePreview(item.id);
          } else setPreviewing(item.id);
        }}
        onUpload={() => startWrite(() => uploadRef.current?.click())}
      />

      {/* The one scrolling region: the rail and the topbar stay put. */}
      <div className="flex min-h-0 flex-1 gap-4 overflow-auto p-3 sm:p-4">
      {activePluginId ? <section className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border bg-card">
        <div className="flex items-center gap-2 border-b px-4 py-3"><Icon name="plugin" size={18} /><h2 className="min-w-0 flex-1 truncate font-medium">{activePlugin ? pluginManifest(activePlugin).name : 'Plugin unavailable'}</h2><Button size="sm" variant="outline" onClick={() => exitPluginApp()}>Back to drive</Button></div>
        {activePlugin ? <div className="min-h-0 flex-1"><SandboxPlugin plugin={activePlugin} /></div> : <p role="alert" className="p-4 text-sm text-muted-foreground">This plugin is no longer enabled in this space.</p>}
      </section> : <>
      <FileDropZone disabled={offline || linkPending || linkListingUnavailable || view !== 'drive'}
        destination={crumbs.at(-1)?.name ?? siteList.sites?.find(site => site.current)?.name ?? 'this space'}
        onError={onError}
        onFiles={chosen => uploads.enqueue(folderId, [siteList.sites?.find(site => site.current)?.name ?? currentSite() ?? 'This space', ...crumbs.map(crumb => crumb.name)].join('/'), chosen)}>
      {offline ? (
        <p role="status" className="mb-3 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          Offline — showing saved file and folder names. File content and changes are unavailable.
        </p>
      ) : null}
      <SelectionSummary selection={selection} items={view === 'search' ? previewFiles.map(file => fileItem(file)) : view === 'trash' ? trash.map(file => fileItem(file)) : [...folders.map(folderItem), ...files.map(file => fileItem(file))]} onClear={() => setSelection(new Set())} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Icon
            name="search"
            className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={term}
            disabled={offline}
            placeholder="Search this space"
            aria-label="Search this space"
            className="h-8 w-44 pl-8 sm:w-56"
            onChange={(e) => {
              const next = e.currentTarget.value;
              // FIRST, before the debounce is even scheduled: the request for the
              // previous term is in flight and still holds the ticket until then.
              reads.current.invalidate();
              setMatchFilter('all');
              setTerm(next);
              setSelection(new Set());
              // The previous term's hits are wrong the moment the box changes, so they
              // go now rather than lingering until the next answer lands. With `busy`
              // set, the list says "Loading…" instead of "No matches" for a search
              // that has not run yet.
              setHits([]);
              setBusy(next.trim().length >= SEARCH_MIN);
              // Emptying the box returns to where you were, rather than leaving an
              // empty result list that looks like "nothing here".
              linkNavigation.current++;
              setLinkPending(false);
              setView(next.trim() ? 'search' : 'drive');
            }}
          />
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const next = layout === 'list' ? 'grid' : 'list';
            setLayout(next);
            saveViewPreferences({ layout: next, sort });
          }}
          aria-label={layout === 'list' ? 'Switch to grid' : 'Switch to list'}
        >
          <Icon name={layout === 'list' ? 'grid' : 'list'} className="size-4" />
        </Button>
      </div>

      <BulkTrash contextKey={`${view}:${folderId}:${term}`} beforeTrash={ids => !previewId.current || !ids.includes(previewId.current) || setPreviewing(null)} visible={view === 'drive' || view === 'search'} files={(view === 'search' ? visibleHits : files).filter(file => selection.has(file.id))} disabled={offline || busy} onTrashed={async ids => {
        setSelection(previous => new Set([...previous].filter(id => !ids.includes(id))));
        await refreshRef.current();
      }} />

      {(view === 'drive' || view === 'search') && previewFiles.some(file => selection.has(file.id)) ? <Button variant="outline" size="sm" className="mb-3" disabled={offline || busy} onClick={() => {
        setMoving(previewFiles.filter(file => selection.has(file.id)).map(file => fileItem(file)));
      }}>Move selected files…</Button> : null}

      <BulkRestore visible={view === 'trash'} files={trash.filter(file => selection.has(file.id))} disabled={offline || busy} onRestored={async ids => {
        setSelection(previous => new Set([...previous].filter(id => !ids.includes(id))));
        await refreshRef.current();
      }} />

      {view === 'search' ? (
        <> {term.trim().length >= SEARCH_MIN ? <SearchMatchFilter hits={hits} value={matchFilter} busy={busy} onChange={changeMatchFilter} /> : null}
        <FileTable
          searchQuery={term.trim()}
          files={sorted(visibleHits, sort).map((hit) => ({ ...fileItem(hit), snippet: hit.snippet ?? undefined, description: hit.snippet || (hit.via === 'content' ? 'Matched inside the document' : hit.via === 'metadata' ? 'Matched in description or labels' : 'Matched in the name') }))}
          selection={selection}
          onSelectionChange={setSelection}
          onOpen={(item) => setPreviewing(item.id)}
          sort={sort}
          onSort={onSort}
          view={layout}
          onAction={onAction}
          pluginMenuItems={() => []}
          loading={busy}
          empty={empty}
        />
        </>
      ) : view === 'trash' ? (
        <FileTable
          files={sorted(trash, sort).map((file) => fileItem(file))}
          trashed
          selection={selection}
          onSelectionChange={setSelection}
          onOpen={(item) => void act(() => restoreFile(item.id))}
          sort={sort}
          onSort={onSort}
          view={layout}
          onAction={onAction}
          pluginMenuItems={() => []}
          loading={busy}
          empty={empty}
        />
      ) : (
        <FileTable
          files={[...sorted(folders, sort).map(folderItem), ...sorted(files, sort).map((file) => fileItem(file))]}
          selection={selection}
          onSelectionChange={setSelection}
          onOpen={(item) => {
            const folder = folders.find((f) => f.id === item.id);
            if (folder) open(folder);
            else if (!offline) setPreviewing(item.id);
          }}
          sort={sort}
          onSort={onSort}
          view={layout}
          onAction={onAction}
          // Drag a file onto a folder: the move the platform's relink makes safe (#75).
          onMove={offline ? undefined : (item, folder) => void act(() => item.isFolder
            ? moveFolder(item.id, folder.id) : moveFile(item.id, folder.id))}
          pluginMenuItems={() => []}
          previewOpen={previewing !== null}
          loading={busy}
          readOnly={offline}
          empty={empty}
        />
      )}
      {view === 'trash' && !offline && trashNext ? (
        <Button variant="outline" size="sm" disabled={busy || loadingPage} onClick={() => void moreTrash()}>
          {loadingPage ? 'Loading Trash…' : 'Load more Trash'}
        </Button>
      ) : null}
      {view === 'drive' && !offline && filesNext ? (
        <Button variant="outline" size="sm" disabled={busy || loadingPage} onClick={() => void moreFiles()}>
          {loadingPage ? 'Loading files…' : 'Load more files'}
        </Button>
      ) : null}
      {view === 'drive' && !offline && foldersNext ? (
        <Button variant="outline" size="sm" disabled={busy || loadingPage} onClick={() => void moreFolders()}>
          {loadingPage ? 'Loading folders…' : 'Load more folders'}
        </Button>
      ) : null}
      </FileDropZone>

      {previewing ? (
        <div className="fixed inset-x-0 bottom-0 top-14 z-20 bg-background md:static md:z-auto md:w-[28rem] md:shrink-0">
          <PreviewPanel
            fileId={previewing}
            navigation={previewNavigation}
            onChanged={() => void refresh()}
            onClose={() => setPreviewing(null)}
            onError={onError}
          />
        </div>
      ) : null}
      </>}
      </div>{/* scrolling region */}
      </div>{/* the column beside the rail */}

      <SpaceSettingsDialog open={spaceSettingsOpen} onOpenChange={setSpaceSettingsOpen} onSaved={siteList.retry} />
      <CreateSpaceDialog open={createSpaceOpen} onOpenChange={setCreateSpaceOpen} onCreated={openSpace} />
      <SpacesDialog open={spacesOpen} onOpenChange={setSpacesOpen} sites={siteList.sites} failed={siteList.failed} onRetry={siteList.retry} offline={offline} canManage={canManagePeople} onSettings={() => setSpaceSettingsOpen(true)} onCreate={() => setCreateSpaceOpen(true)} onMembers={() => setPeopleOpen(true)} />
      <PluginManagement open={viewersOpen} onOpenChange={setViewersOpen} spaceName={siteList.sites?.find(site => site.current)?.name} onOpenApp={id => { changePreview(null); setActivePluginId(id); }} />

      <PeopleDialog open={peopleOpen} onOpenChange={setPeopleOpen} />

      <ShareDialog folder={sharing} onClose={() => setSharing(null)} me={auth.principal} />

      {moving ? <MoveDialog items={moving} sourceFolderId={view === 'drive' ? folderId : null}
        onClose={() => setMoving(null)} onMoved={async ids => {
          setSelection(previous => new Set([...previous].filter(id => !ids.includes(id))));
          await refreshRef.current();
        }} /> : null}

      {creating ? (
        <NameDialog
          title="New folder"
          initial=""
          confirm="Create"
          onCancel={() => setCreating(false)}
          onConfirm={(name) => {
            setCreating(false);
            void act(() => createFolder(folderId, name));
          }}
        />
      ) : null}

      {renaming ? (
        <NameDialog
          title={renaming.kind === 'folder' ? 'Rename folder' : 'Rename file'}
          initial={renaming.name}
          confirm="Rename"
          onCancel={() => setRenaming(null)}
          onConfirm={(name) => {
            const target = renaming;
            setRenaming(null);
            void act(() =>
              target.kind === 'folder' ? renameFolder(target.id, name) : renameFile(target.id, name),
            );
          }}
        />
      ) : null}
    </div>
  );
}

function EmptyList({ icon, title, description, actions = [] }: {
  icon: string;
  title: string;
  description: string;
  actions?: Array<{ label: string; onClick: () => void }>;
}) {
  return (
    <div role="status" className="flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed px-4 py-8 text-center">
      <Icon name={icon} size={24} className="mb-3 text-muted-foreground" />
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      {actions.length > 0 && (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {actions.map((action, index) => (
            <Button key={action.label} size="sm" variant={index === 0 ? 'default' : 'outline'} onClick={action.onClick}>
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One name, typed. The same shape the portal's `NameDialog` has, and it exists for the
 * same reason: `window.prompt` cannot be styled, cannot be tested and is blocked
 * outright in some embedded webviews.
 */
function NameDialog({
  title,
  initial,
  confirm,
  onCancel,
  onConfirm,
}: {
  title: string;
  initial: string;
  confirm: string;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  const trimmed = name.trim();
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal>
      <form
        className="w-full max-w-sm rounded-lg border border-border bg-background p-4 shadow-lg"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed) onConfirm(trimmed);
        }}
      >
        <h2 className="mb-3 text-sm font-medium">{title}</h2>
        {/* Named, because a dialog whose only field has no accessible name is one a
            screen reader announces as "edit text" — and one a test cannot address
            unambiguously when the toolbar also holds an input. */}
        <Input
          autoFocus
          aria-label={title}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          A name is one segment: no slashes, and not <code>.</code> or <code>..</code>
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!trimmed}>
            {confirm}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** Dates as the portal shows them: relative while it is useful, absolute after. */
function when(iso: string): string {
  const then = new Date(iso).getTime();
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}
