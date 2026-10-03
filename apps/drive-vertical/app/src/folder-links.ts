import { currentSite, LOGIN_URL } from './api';

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
  url.searchParams.set('folder', folderId);
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

/** Login returns only navigation parameters, never invite/claim credentials. */
export function folderLoginUrl(): string {
  const id = linkedFolderId();
  const path = folderPath();
  if (!id && !path) return LOGIN_URL;
  const target = new URL(id ? folderIdLink(id) : folderLink(path));
  return `${LOGIN_URL}?returnTo=${encodeURIComponent(target.pathname + target.search)}`;
}
