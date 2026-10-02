import { currentSite, LOGIN_URL } from './api';

/** Navigation only: this URL grants no access and contains no invitation credentials. */
export function folderLink(path: string): string {
  const url = new URL('/', window.location.origin);
  const site = currentSite();
  if (site) url.searchParams.set('site', site);
  if (path) url.searchParams.set('path', path);
  return url.toString();
}

/** Only a link naming the active selection may resolve a path in that scope. */
export function folderPath(): string {
  const url = new URL(window.location.href);
  const linkedSite = url.searchParams.get('site');
  return linkedSite && linkedSite !== currentSite() ? '' : url.searchParams.get('path') ?? '';
}

/** Login returns only navigation parameters, never invite/claim credentials. */
export function folderLoginUrl(): string {
  const path = folderPath();
  if (!path) return LOGIN_URL;
  const target = new URL(folderLink(path));
  return `${LOGIN_URL}?returnTo=${encodeURIComponent(target.pathname + target.search)}`;
}
