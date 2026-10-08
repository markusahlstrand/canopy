import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MoveDialog } from './move-dialog';
import * as api from './api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); api.selectSite(null); });
it('retries a failed destination lookup in the original space without losing the selection', async () => {
  api.selectSite('original');
  const list = vi.spyOn(api, 'listFoldersPage').mockRejectedValueOnce(new Error('Connection failed')).mockResolvedValue({ entries: [], next: null });
  const move = vi.spyOn(api, 'moveFile');
  render(<MoveDialog items={[{ id: 'a', name: 'Report', kind: 'doc', modified: '', size: '', isFolder: false }]} sourceFolderId="source" onClose={() => {}} onMoved={async () => {}} />);
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'Move here' }).hasAttribute('disabled')).toBe(true);
  expect(move).not.toHaveBeenCalled();
  api.selectSite('other');
  fireEvent.click(screen.getByRole('button', { name: 'Retry destination folders' }));
  await screen.findByText('No subfolders');
  expect(list.mock.calls).toEqual([['root', null, 'original'], ['root', null, 'original']]);
  expect(screen.getByLabelText('Files remaining to move').textContent).toBe('Report');
  expect(screen.getByRole('button', { name: 'Move here' }).hasAttribute('disabled')).toBe(false);
});
