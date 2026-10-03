import { selectSite } from './api';
import { confirmNavigation } from './navigation-guards';
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
