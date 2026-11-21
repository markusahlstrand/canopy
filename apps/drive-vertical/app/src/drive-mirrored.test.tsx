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

it('answers an empty mirrored folder with what the last sync found', async () => {
  const source = { provider: 'canopy.a3doc', connectionId: 'c1', account: 'ACME', folder: 'Facturas', canUpload: false, boundAt: '2026-10-31T09:00:00.000Z' };
  const report = { at: '2026-11-06T22:00:00.000Z', complete: true, total: 3, read: 3, skipped: 3, skippedContainers: [99], files: 0 };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(
    url === '/api/source' ? { source } : url === '/api/source/status' ? { source, binding: { status: 'active', lastSyncedAt: report.at, lastError: null }, report } : url.endsWith('/access') ? { canManage: false } : [])));
  render(<DriveScreen {...shell} />);
  await screen.findByText('3 of 3 documents read were skipped because a3doc files them outside this folder. They name a3doc folder 99.');
});

it('checks the open folder against a3doc and says when, without holding up the listing', async () => {
  const source = { provider: 'canopy.a3doc', connectionId: 'c1', account: 'ACME', folder: '', canUpload: false, boundAt: '2026-10-31T09:00:00.000Z' };
  const checks: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/refresh') && init?.method === 'POST') {
      checks.push(url);
      return Response.json({ refresh: { folderId: 'root', path: '', state: 'checked', checkedAt: new Date().toISOString(), error: null, changes: 0 } });
    }
    return Response.json(url === '/api/source' ? { source } : url.endsWith('/access') ? { canManage: false } : []);
  }));
  render(<DriveScreen {...shell} />);
  await screen.findByText('Documents added to this a3doc folder appear here.');
  await screen.findByText('Checked just now.');
  expect(screen.getByRole('button', { name: 'Check this folder in a3doc now' })).toBeTruthy();
  expect(checks).toEqual(['/api/source/folders/root/refresh']);
});

it('asks nothing of a source in an ordinary space', async () => {
  const fetcher = vi.fn(async (url: string) => Response.json(url === '/api/source' ? { source: null } : url.endsWith('/access') ? { canManage: false } : []));
  vi.stubGlobal('fetch', fetcher);
  render(<DriveScreen {...shell} />);
  await screen.findByText('Create a folder or upload files to get started.');
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/refresh'))).toBe(false);
  expect(screen.queryByTestId('folder-freshness')).toBeNull();
});
