import { viewerMatches } from '@canopy/core';
/** Match a search against viewer patterns with the same rules used when a file is opened. */
export function viewerMatchesSearch(match: string[], rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return false;
  if (query.includes('/')) return viewerMatches(match, {mime: query.split(';')[0]!.trim()});
  return viewerMatches(match, {ext: query.startsWith('.') ? query.slice(1) : query.split('.').at(-1)});
}
/** Plain words search names and descriptions; anything shaped like a file type goes through the viewer matcher. */
export const isFileTypeQuery = (query: string) => query.includes('/') || query.includes('.');
