import 'fake-indexeddb/auto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { cacheOfflineVersion, clearOfflineContent, resumeOfflineContent, setOfflinePin } from './offline-content';
import { OfflinePreview } from './offline-preview';
import type { DriveFile } from './api';

const file: DriveFile = { id: 'file', folder_id: 'docs', name: 'note.txt', current_version_id: 'v1',
  created_at: '2026-10-07', updated_at: '2026-10-07', deleted_at: null };

beforeEach(async () => {
  await clearOfflineContent(); await resumeOfflineContent();
  await setOfflinePin({ principal: 'alice', space: 'family', folderId: 'docs', name: 'Docs', status: 'ready', updatedAt: 1 });
  await cacheOfflineVersion({ principal: 'alice', space: 'family', fileId: 'file', versionId: 'v1',
    folderId: 'docs', name: 'note.txt', mime: 'text/plain', url: '/content' }, async () => new Response('hello offline'));
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:cached'), revokeObjectURL: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('opens a cached text version read-only and offers its saved bytes for download', async () => {
  render(<OfflinePreview file={file} principal="alice" space="family" onClose={() => {}} />);
  expect(await screen.findByText('hello offline')).toBeTruthy();
  expect(screen.getByText(/Read-only saved version/)).toBeTruthy();
  expect((await screen.findByRole('link', { name: 'Download saved version' })).getAttribute('href')).toBe('blob:cached');
});

it('does not reveal another principal’s cached file', async () => {
  render(<OfflinePreview file={file} principal="bob" space="family" onClose={() => {}} />);
  expect(await screen.findByText(/no saved offline copy/)).toBeTruthy();
  expect(screen.queryByText('hello offline')).toBeNull();
});
