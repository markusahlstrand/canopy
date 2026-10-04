import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { listSites, type Site } from './api';
import { useSites } from './sidebar';

vi.mock('./api', () => ({ listSites: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function Roster() {
  const { sites, failed } = useSites();
  return <p>{failed ? 'Failed' : sites?.map(site => site.name).join(', ') ?? 'Loading'}</p>;
}

it('refreshes spaces on focus without letting an older response overwrite the new roster', async () => {
  let finishFirst!: (sites: Site[]) => void;
  vi.mocked(listSites)
    .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
    .mockResolvedValueOnce([{ slug: 'new', name: 'New space', current: true }]);
  render(<Roster />);
  fireEvent.focus(window);
  await waitFor(() => expect(screen.getByText('New space')).toBeTruthy());
  finishFirst([{ slug: 'old', name: 'Old space', current: true }]);
  await waitFor(() => expect(screen.queryByText('Old space')).toBeNull());
});
