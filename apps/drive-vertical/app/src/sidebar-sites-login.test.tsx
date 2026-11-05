import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { listSites } from './api';
import { bindSitesToLogin, useSites } from './sidebar';

vi.mock('./api', () => ({ listSites: vi.fn(), currentSite: () => 'shared' }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function Roster() {
  const { sites } = useSites();
  return <p>{sites?.map(site => site.name).join(', ') ?? 'Loading'}</p>;
}

it("a remounted rail starts from the cached list only for the login that read it", async () => {
  bindSitesToLogin('ada@example.com');
  vi.mocked(listSites).mockResolvedValueOnce([{ slug: 'shared', name: "Ada's spaces", current: true }]);
  render(<Roster />);
  await waitFor(() => expect(screen.getByText("Ada's spaces")).toBeTruthy());
  cleanup();

  // Same login, list still pending: the rail starts from the cache.
  vi.mocked(listSites).mockImplementation(() => new Promise(() => {}));
  render(<Roster />);
  expect(screen.getByText("Ada's spaces")).toBeTruthy();
  cleanup();

  // Another login: nothing of Ada's is shown while its own list loads.
  bindSitesToLogin('bo@example.com');
  render(<Roster />);
  expect(screen.getByText('Loading')).toBeTruthy();
  cleanup();

  // Signed out, then the same login again: the cache did not survive the sign-out.
  bindSitesToLogin(null);
  bindSitesToLogin('bo@example.com');
  render(<Roster />);
  expect(screen.getByText('Loading')).toBeTruthy();
});
