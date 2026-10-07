import { selectSite, type Site } from './api';
import { confirmNavigation } from './navigation-guards';
/** Keep a usable label when an older space has no display name. */
export const spaceLabel = (site: Pick<Site, 'name' | 'slug'>): string => site.name.trim() || site.slug;
/** A portable link to a space, without a file or folder from the sender's view. */
export function spaceLink(slug: string): string {
  const url = new URL('/', window.location.origin);
  url.searchParams.set('site', slug);
  return url.toString();
}
/** Switch only after the draft boundary; remove destinations belonging to the old space. */
export function openSpace(slug: string) {
  if (!confirmNavigation()) return false;
  const url = new URL(window.location.href);
  for (const key of ['path', 'folder', 'file']) url.searchParams.delete(key);
  if (selectSite(slug)) url.searchParams.delete('site');
  else url.searchParams.set('site', slug);
  window.history.replaceState(null, '', url);
  window.location.reload();
  return true;
}

/** Follow a shared-folder grant in another space without losing the folder on reload. */
export function openSpaceFolder(slug: string, folderId: string) {
  if (!confirmNavigation()) return false;
  const url = new URL(window.location.href);
  url.searchParams.delete('path');
  url.searchParams.delete('file');
  url.searchParams.set('folder', folderId);
  if (selectSite(slug)) url.searchParams.delete('site');
  else url.searchParams.set('site', slug);
  window.history.replaceState(null, '', url);
  window.location.reload();
  return true;
}
