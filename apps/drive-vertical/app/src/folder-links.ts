import { currentSite, LOGIN_URL, ROOT_FOLDER_ID } from './api';
import { fileLink, linkedFileId } from './file-links';

/** Navigation only: this URL grants no access and contains no invitation credentials. */
export function folderLink(path: string, site = currentSite()): string {
  const url = new URL('/', window.location.origin);
  if (site) url.searchParams.set('site', site);
  if (path) url.searchParams.set('path', path);
  return url.toString();
}

/** Opaque IDs survive renames and keep folder/ancestor names out of copied URLs. */
export function folderIdLink(folderId: string, site = currentSite()): string {
  const url = new URL('/', window.location.origin);
  if (site) url.searchParams.set('site', site);
  if (folderId !== ROOT_FOLDER_ID) url.searchParams.set('folder', folderId);
  return url.toString();
}
export function linkedFolderId(): string {
  const url = new URL(window.location.href);
  const linkedSite = url.searchParams.get('site');
  return linkedSite && linkedSite !== currentSite() ? '' : url.searchParams.get('folder') ?? '';
}

/** Only a link naming the active selection may resolve a path in that scope. */
export function folderPath(): string {
  const url = new URL(window.location.href);
  const linkedSite = url.searchParams.get('site');
  return linkedSite && linkedSite !== currentSite() ? '' : url.searchParams.get('path') ?? '';
}

/** The view a link names. Search is left out: a query would put what you typed in a shared URL. */
export function linkedView(): 'drive' | 'trash' | 'shared' {
  const url = new URL(window.location.href);
  const linkedSite = url.searchParams.get('site');
  const view = linkedSite && linkedSite !== currentSite() ? null : url.searchParams.get('view');
  return view === 'trash' || view === 'shared' ? view : 'drive';
}

/**
 * What one entry of this tab's history restores. Crumb names and the search term stay in
 * `history.state`, which never leaves the browser; only the IDs reach the URL.
 */
export interface DriveEntry {
  folderId: string;
  crumbs: { id: string; name: string }[];
  view: 'drive' | 'trash' | 'search' | 'shared';
  fileId: string | null;
  term: string;
}

/**
 * Keep the address bar on what the screen shows, so it can be sent as a link.
 *
 * The same stable IDs as the copy-link buttons, so no folder or file name reaches the URL.
 * The space is always named: without it a link opens in the reader's own selected space.
 * Anything else in the URL is not ours to rewrite. `push` is for a move Back should undo;
 * tidying the current address replaces it, so Back has no stop that shows the same screen.
 */
export function showInUrl(site: string | null, entry: DriveEntry, push: boolean) {
  const { folderId, fileId, view } = entry;
  const url = new URL(window.location.href);
  for (const key of ['path', 'folder', 'file', 'view']) url.searchParams.delete(key);
  if (site) url.searchParams.set('site', site);
  if (view === 'trash' || view === 'shared') url.searchParams.set('view', view);
  if (fileId) url.searchParams.set('file', fileId);
  else if (folderId !== ROOT_FOLDER_ID && view !== 'trash' && view !== 'shared') url.searchParams.set('folder', folderId);
  if (push) window.history.pushState(entry, '', url);
  else window.history.replaceState(entry, '', url);
}

/** Login returns only navigation parameters, never invite/claim credentials. */
export function folderLoginUrl(): string {
  const fileId = linkedFileId();
  const id = linkedFolderId();
  const path = folderPath();
  const view = linkedView();
  if (!fileId && !id && !path && view === 'drive' && !currentSite()) return LOGIN_URL;
  const target = new URL(fileId ? fileLink(fileId) : id ? folderIdLink(id) : folderLink(path));
  if (view !== 'drive') target.searchParams.set('view', view);
  return `${LOGIN_URL}?returnTo=${encodeURIComponent(target.pathname + target.search)}`;
}
