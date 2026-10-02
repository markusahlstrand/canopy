import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { DriveScreen } from './drive';
import { folderLink } from './folder-links';
import { selectSite } from './api';
afterEach(() => { cleanup(); selectSite(null); history.replaceState(null, '', '/'); vi.unstubAllGlobals(); });
it('encodes the selected space and folder without carrying live credentials', () => {
  history.replaceState(null, '', '/?invite=secret');
  selectSite('family');
  const link = new URL(folderLink('Shared/Plans & reports'));
  expect(link.searchParams.get('site')).toBe('family');
  expect(link.searchParams.get('path')).toBe('Shared/Plans & reports');
  expect(link.searchParams.has('invite')).toBe(false);
});
it('resolves a deep link before reading its folder listing', async () => {
  history.replaceState(null, '', '/?path=Shared%2FPapers');
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(
    url.includes('/by-path?') ? { id: 'papers', name: 'Papers', path: 'Shared/Papers' }
      : url === '/api/sites' ? { sites: [] } : url.endsWith('/access') ? { canManage: false } : [])));
  vi.stubGlobal('fetch', fetch);
  render(<DriveScreen onError={() => {}} auth={{ user: {} }} onSignIn={() => {}} onSignOut={() => {}} />);
  await screen.findAllByText('Shared/Papers');
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/folders/papers/files', expect.anything()));
  expect(fetch.mock.calls.some(([url]) => url === '/api/folders/root/files')).toBe(false);
});
