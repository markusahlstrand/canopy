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
/** Drop the destinations and invitations that belong to the space being left. */
function clearPreviousSpaceLink(url: URL) {
  for (const key of ['path', 'folder', 'file', 'claim', 'invite']) url.searchParams.delete(key);
  url.hash = '';
}
/**
 * How the shell changes space in place: `apply` selects the space and rewrites the URL,
 * and the shell calls it once it can render the new space whole. Without a registered
 * switcher (a screen mounted on its own, a test) a space change is apply-then-reload.
 */
type SpaceSwitcher = (slug: string, apply: () => void) => void;
let switcher: SpaceSwitcher | null = null;
/** Register the shell's in-place switcher; returns the unregister. */
export function handleSpaceSwitch(next: SpaceSwitcher): () => void {
  switcher = next;
  return () => { if (switcher === next) switcher = null; };
}

/** Hand a switch to the registered switcher, or apply it and reload. */
function switchSpace(slug: string, apply: () => void) {
  if (switcher) return switcher(slug, apply);
  apply();
  window.location.reload();
}

/** Switch only after the draft boundary; remove destinations belonging to the old space. */
export function openSpace(slug: string) {
  if (!confirmNavigation()) return false;
  switchSpace(slug, () => selectInUrl(slug));
  return true;
}

/** Select `slug`, and leave the URL agreeing with the selection (see the sidebar's rule). */
function selectInUrl(slug: string, target?: { key: 'folder' | 'file'; id: string }) {
  const url = new URL(window.location.href);
  clearPreviousSpaceLink(url);
  if (target) url.searchParams.set(target.key, target.id);
  if (selectSite(slug)) url.searchParams.delete('site');
  else url.searchParams.set('site', slug);
  window.history.replaceState(null, '', url);
}

/** Follow a shared-folder grant in another space without losing the folder on reload. */
export function openSpaceFolder(slug: string, folderId: string) {
  return openInSpace(slug, 'folder', folderId);
}

/** Open a file in another space — an assistant source — behind the same draft boundary. */
export function openSpaceFile(slug: string, fileId: string) {
  return openInSpace(slug, 'file', fileId);
}

/** Open a folder or file of `slug` behind the draft boundary. */
function openInSpace(slug: string, key: 'folder' | 'file', id: string) {
  if (!confirmNavigation()) return false;
  switchSpace(slug, () => selectInUrl(slug, { key, id }));
  return true;
}
