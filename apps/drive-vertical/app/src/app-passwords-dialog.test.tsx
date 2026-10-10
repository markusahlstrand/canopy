import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AppPasswordsDialog } from './app-passwords-dialog';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

it('shows the server address, creates a password shown once, and revokes one', async () => {
  let rows = [{ id: 'old', name: 'Old laptop', created_at: Date.UTC(2026, 0, 2), last_used_at: null }];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/app-passwords' && init?.method === 'POST') {
      expect(JSON.parse(init.body as string)).toEqual({ name: 'Finder' });
      return json({ id: 'new', name: 'Finder', created_at: Date.UTC(2026, 9, 10), last_used_at: null, password: 'canopy_secret' }, 201);
    }
    if (url === '/api/app-passwords/old' && init?.method === 'DELETE') { rows = []; return new Response(null, { status: 204 }); }
    return json({ passwords: rows });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<AppPasswordsDialog open onOpenChange={() => {}} />);

  expect((screen.getByLabelText('Server address') as HTMLInputElement).value).toBe(`${window.location.origin}/dav/`);
  expect(await screen.findByText('Old laptop')).toBeTruthy();
  expect(screen.getByText(/Never used/)).toBeTruthy();

  fireEvent.change(screen.getByLabelText('New app password'), { target: { value: '  Finder ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  const shown = await screen.findByRole('status', { name: 'Created app password' });
  expect((within(shown).getByLabelText('App password for Finder') as HTMLInputElement).value).toBe('canopy_secret');
  expect(within(shown).getByText(/won’t be shown again/)).toBeTruthy();
  expect((screen.getByLabelText('New app password') as HTMLInputElement).value).toBe('');
  // The secret appears once, in the panel; the list row carries only the name.
  expect(screen.getAllByDisplayValue('canopy_secret')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Revoke Finder' })).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Revoke Old laptop' }));
  await waitFor(() => expect(screen.queryByText('Old laptop')).toBeNull());
  expect(fetcher.mock.calls.some(([url, init]) => url === '/api/app-passwords/old' && init?.method === 'DELETE')).toBe(true);
});

it('keeps the typed name and explains a refused creation', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
    ? json({ detail: 'This login already has 20 app passwords. Revoke one you no longer use.' }, 409)
    : json({ passwords: [] })));
  render(<AppPasswordsDialog open onOpenChange={() => {}} />);
  expect(await screen.findByText('No app passwords yet.')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('New app password'), { target: { value: 'Explorer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/already has 20 app passwords/);
  expect((screen.getByLabelText('New app password') as HTMLInputElement).value).toBe('Explorer');
  expect(screen.queryByRole('status', { name: 'Created app password' })).toBeNull();
});

it('offers a retry when the list cannot load', async () => {
  let fail = true;
  vi.stubGlobal('fetch', vi.fn(async () => (fail ? json({ detail: 'Service unavailable' }, 503) : json({ passwords: [] }))));
  render(<AppPasswordsDialog open onOpenChange={() => {}} />);
  expect((await screen.findByRole('alert')).textContent).toMatch(/Service unavailable/);
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('No app passwords yet.')).toBeTruthy();
});
