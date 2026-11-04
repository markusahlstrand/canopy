import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SpaceSettingsDialog } from './space-settings-dialog';
import * as api from './api';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); api.selectSite(null); });

function fetcher(deleteStatus: number) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return deleteStatus === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ detail: 'Only an owner can delete this space.' }), { status: deleteStatus });
    if (url.includes('/source')) return new Response(JSON.stringify({ source: null }));
    return new Response(JSON.stringify({ name: 'Family', icon: 'home', color: '#10b981' }));
  });
}

it('arms deletion only once the space name is typed, then leaves for the home space', async () => {
  api.selectSite('family');
  const fetch = fetcher(204); vi.stubGlobal('fetch', fetch);
  const replace = vi.fn(); vi.stubGlobal('location', { ...window.location, href: 'http://localhost/?site=family&folder=x', replace });
  render(<SpaceSettingsDialog open onOpenChange={() => {}} onSaved={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /Delete space/ }));
  const confirm = screen.getByRole('button', { name: 'Delete this space' }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'Famil' } });
  expect(confirm.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'Family' } });
  fireEvent.click(confirm);
  await waitFor(() => expect(replace).toHaveBeenCalledOnce());
  expect(fetch.mock.calls.some(([url, init]) => init?.method === 'DELETE' && String(url).endsWith('/api/sites/family'))).toBe(true);
  expect(String(replace.mock.calls[0]![0])).toBe('http://localhost/');
  expect(api.currentSite()).toBeNull();
});

it('keeps the space selected and says why when deletion is refused', async () => {
  api.selectSite('family');
  vi.stubGlobal('fetch', fetcher(403));
  render(<SpaceSettingsDialog open onOpenChange={() => {}} onSaved={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /Delete space/ }));
  fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'Family' } });
  fireEvent.click(screen.getByRole('button', { name: 'Delete this space' }));
  expect((await screen.findByRole('alert')).textContent).toContain('owner');
  expect(api.currentSite()).toBe('family');
});

it('offers no deletion on the home space, which has no selection', async () => {
  api.selectSite(null);
  vi.stubGlobal('fetch', fetcher(204));
  render(<SpaceSettingsDialog open onOpenChange={() => {}} onSaved={() => {}} />);
  await screen.findByLabelText('Space name');
  expect(screen.queryByRole('button', { name: /Delete space/ })).toBeNull();
});
