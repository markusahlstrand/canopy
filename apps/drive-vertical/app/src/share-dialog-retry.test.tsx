import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ShareDialog } from './share-dialog';
import * as api from './api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('does not claim the folder has no grants when access lookup fails, and allows retry', async () => {
  vi.spyOn(api, 'getFolder').mockResolvedValue({ id: 'folder', name: 'Folder', path: 'Folder', parent_id: 'root', canManage: true });
  vi.spyOn(api, 'listSites').mockResolvedValue([{ slug: 'family', name: 'Family', current: true }]);
  vi.spyOn(api, 'listPeople').mockResolvedValue({ people: [] });
  const shares = vi.spyOn(api, 'listFolderShares').mockRejectedValueOnce(new Error('Connection failed')).mockResolvedValue({ shares: [] });
  render(<ShareDialog folder={{ id: 'folder', name: 'Folder' }} onClose={() => {}} />);
  await screen.findByText(/Access could not be checked/);
  expect(screen.queryByText(/Nobody yet/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry folder access' }));
  await screen.findByText(/Nobody yet/);
  expect(shares).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(/Access could not be checked/)).toBeNull();
});
