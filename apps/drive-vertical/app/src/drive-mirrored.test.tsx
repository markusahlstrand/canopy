import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DriveScreen } from './drive';
vi.mock('./live-updates', () => ({ watchDriveChanges: () => () => {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const shell = { onError: () => {}, auth: { user: {} }, onSignIn: () => {}, onSignOut: () => {} };

function space(canUpload: boolean) {
  const source = { provider: 'canopy.a3doc', connectionId: 'c1', account: 'ACME', folder: '', canUpload, boundAt: '2026-10-31T09:00:00.000Z' };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url === '/api/source' ? { source } : url.endsWith('/access') ? { canManage: false } : [])));
}

it('offers neither folders nor uploads in a space whose a3doc user can only read', async () => {
  space(false);
  render(<DriveScreen {...shell} />);
  await screen.findByText('Documents added to this a3doc folder appear here.');
  expect(screen.queryByRole('button', { name: /Upload/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull();
  expect((screen.getByRole('button', { name: 'New' }) as HTMLButtonElement).disabled).toBe(true);
});

it('offers uploads, but not folders, when the a3doc user may upload', async () => {
  space(true);
  render(<DriveScreen {...shell} />);
  await screen.findByText('Documents added to this a3doc folder appear here.');
  expect(screen.getAllByRole('button', { name: /Upload/ }).length).toBeGreaterThan(0);
  expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull();
});
