import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { DriveScreen } from './drive';
import { folderLink, folderPath, folderLoginUrl } from './folder-links';
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
      : url.endsWith('/access') ? { canManage: false } : [])));
  vi.stubGlobal('fetch', fetch);
  render(<DriveScreen onError={() => {}} auth={{ user: {} }} onSignIn={() => {}} onSignOut={() => {}} />);
  await screen.findAllByText('Shared/Papers');
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/folders/papers/files', expect.anything()));
  expect(fetch.mock.calls.some(([url]) => url === '/api/folders/root/files')).toBe(false);
  expect(location.search).toBe('');
});

it('does not resolve a linked path after the active space has changed', () => {
  selectSite('space-b');
  history.replaceState(null, '', '/?site=space-a&path=Papers');
  expect(folderPath()).toBe('');
});
it('keeps a credential-free folder destination across sign-in', () => {
  selectSite('space-a');
  history.replaceState(null, '', '/?site=space-a&path=Papers&invite=secret');
  const login = new URL(folderLoginUrl(), location.origin);
  expect(login.searchParams.get('returnTo')).toBe('/?site=space-a&path=Papers');
});
it('keeps an invitation space through sign-in even without a folder destination', () => {
  selectSite('invited-space');
  history.replaceState(null, '', '/?site=invited-space&invite=secret');
  const login = new URL(folderLoginUrl(), location.origin);
  expect(login.searchParams.get('returnTo')).toBe('/?site=invited-space');
  expect(login.toString()).not.toContain('secret');
});
it('cleans up an unavailable link and reports a single unavailable state', async () => {
  history.replaceState(null, '', '/?path=Missing');
  vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(url.includes('by-path') ? null : url.endsWith('/access') ? { canManage: false } : [])));
  render(<DriveScreen onError={() => {}} auth={{ user: {} }} onSignIn={() => {}} onSignOut={() => {}} />);
  await screen.findByText('This folder is unavailable or you do not have access.');
  expect(location.search).toBe('');
});
