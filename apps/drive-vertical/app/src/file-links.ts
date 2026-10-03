import { currentSite } from './api';

/** Stable navigation URL; it grants no access and contains no names or credentials. */
export function fileLink(fileId: string, site = currentSite()): string {
  const url = new URL('/', window.location.origin);
  if (site) url.searchParams.set('site', site);
  url.searchParams.set('file', fileId);
  return url.toString();
}
export function linkedFileId(): string {
  const url = new URL(window.location.href);
  const linkedSite = url.searchParams.get('site');
  return linkedSite && linkedSite !== currentSite() ? '' : url.searchParams.get('file') ?? '';
}
