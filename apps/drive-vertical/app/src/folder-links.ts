import { currentSite } from './api';

/** Navigation only: this URL grants no access and contains no invitation credentials. */
export function folderLink(path: string): string {
  const url = new URL('/', window.location.origin);
  const site = currentSite();
  if (site) url.searchParams.set('site', site);
  if (path) url.searchParams.set('path', path);
  return url.toString();
}
