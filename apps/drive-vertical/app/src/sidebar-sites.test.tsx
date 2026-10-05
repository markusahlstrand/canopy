import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { listSites, type Site } from './api';
import { useSites } from './sidebar';

vi.mock('./api', () => ({ listSites: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); Reflect.deleteProperty(document, 'visibilityState'); });

function Roster() {
  const { sites, failed, retry } = useSites();
  return <><p>{failed ? 'Failed' : sites?.map(site => site.name).join(', ') ?? 'Loading'}</p><button onClick={retry}>Retry</button></>;
}

it('keeps an older response from overwriting a manual retry', async () => {
  let finishFirst!: (sites: Site[]) => void;
  vi.mocked(listSites)
    .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
    .mockResolvedValueOnce([{ slug: 'new', name: 'New space', current: true }]);
  render(<Roster />);
  fireEvent.click(screen.getByText('Retry'));
  await waitFor(() => expect(screen.getByText('New space')).toBeTruthy());
  finishFirst([{ slug: 'old', name: 'Old space', current: true }]);
  await waitFor(() => expect(screen.queryByText('Old space')).toBeNull());
});

it('keeps the last good roster when a background refresh fails', async () => {
  vi.spyOn(Date, 'now').mockReturnValueOnce(1).mockReturnValue(30_002);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.mocked(listSites).mockResolvedValueOnce([{ slug: 'home', name: 'Home', current: true }]).mockRejectedValueOnce(new Error('offline'));
  render(<Roster />);
  await waitFor(() => expect(screen.getByText('Home')).toBeTruthy());
  fireEvent(document, new Event('visibilitychange'));
  await waitFor(() => expect(listSites).toHaveBeenCalledTimes(2));
  expect(screen.getByText('Home')).toBeTruthy();
  expect(screen.queryByText('Failed')).toBeNull();
  fireEvent(document, new Event('visibilitychange'));
  expect(listSites).toHaveBeenCalledTimes(2);
});
