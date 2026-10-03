import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FileMetadata } from './file-metadata';
import { PreviewPanel } from './preview';
import type { DriveFile, FileVersion } from './api';
const file: DriveFile = { id: 'file', folder_id: 'root', name: '<script>report.zip</script>', current_version_id: 'v', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z', deleted_at: null };
const version: FileVersion = { id: 'v', file_id: 'file', source: 'blob', blob_ref: 'private-storage-key', mime: 'application/zip', size: 1024, created_at: file.updated_at, keep: 0 };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('shows safe readable metadata and valid timestamps without internal storage keys', () => {
  const view = render(<FileMetadata file={file} version={version} size="1.0 KB" canWrite={false} />);
  const info = screen.getByRole('region', { name: 'File information' });
  expect(within(info).getByText(file.name)).toBeTruthy(); expect(info.querySelector('script')).toBeNull();
  expect(within(info).getByText('Read only')).toBeTruthy(); expect(within(info).getByText('1.0 KB')).toBeTruthy();
  expect(info.textContent).not.toContain(version.blob_ref);
  expect([...info.querySelectorAll('time')].map(time => time.dateTime)).toEqual(['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z']);
  view.rerender(<FileMetadata file={{ ...file, created_at: 'bad', updated_at: '' }} version={null} size="—" canWrite />);
  expect(screen.getByText('Can edit')).toBeTruthy(); expect(screen.getAllByText('Unknown')).toHaveLength(3);
  expect(info.querySelector('time')).toBeNull();
});
it('uses existing preview metadata and keeps the editable Details panel available', async () => {
  const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/plugins') ? {plugins: []} : url.endsWith('/details')
    ? { fileId: file.id, description: 'Description', labels: [], revision: 0, canWrite: false }
    : { file, version, canWrite: false })));
  vi.stubGlobal('fetch', fetcher);
  render(<PreviewPanel fileId={file.id} onClose={() => {}} onError={() => {}} />);
  await screen.findByText(file.name);
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  await screen.findByText('Description');
  expect(screen.getByRole('region', { name: 'File information' }).textContent).toContain('1.0 kB');
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/plugins', '/api/files/file', '/api/files/file/details']);
});
