import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { checkedAgo, DEFAULT_RECHECK_WINDOW_MS, FolderFreshness, freshnessText, useFolderFreshness } from './folder-freshness';
import type { FolderRefresh, FolderRefreshAnswer } from './api';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const NOW = Date.parse('2026-11-21T10:00:00.000Z');
const state = (s: FolderRefresh['state'], extra: Partial<FolderRefresh> = {}): FolderRefresh =>
  ({ folderId: 'f1', path: 'Recibidas', state: s, checkedAt: null, error: null, changes: 0, ...extra });

function Harness({ folderId = 'f1', enabled = true, onChecked }: { folderId?: string; enabled?: boolean; onChecked: () => void }) {
  const f = useFolderFreshness(folderId, enabled, onChecked);
  return <FolderFreshness refresh={f.refresh} asking={f.asking} stalled={f.stalled} label="a3doc" onCheck={f.check} />;
}

/** The worker's answers, in order; the last repeats. */
function answers(...list: FolderRefreshAnswer[]) {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(list.length > 1 ? list.shift() : list[0]));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const bodies = (fetcher: ReturnType<typeof answers>) => fetcher.mock.calls.map(([url, init]) => [String(url).replace(/^.*\/api/, ''), JSON.parse(String(init?.body))]);

it('words the folder\'s state, and how long ago it was checked', () => {
  expect(checkedAgo('2026-11-21T09:59:30.000Z', NOW)).toBe('just now');
  expect(checkedAgo('2026-11-21T09:56:00.000Z', NOW)).toBe('4 min ago');
  expect(checkedAgo('2026-11-21T07:00:00.000Z', NOW)).toMatch(/^at /);
  expect(checkedAgo('2026-11-19T07:00:00.000Z', NOW)).toMatch(/^on .* at /);
  expect(freshnessText(state('checking'), 'a3doc', NOW)).toBe('Checking a3doc for changes…');
  expect(freshnessText(state('checked', { checkedAt: '2026-11-21T09:59:50.000Z' }), 'a3doc', NOW)).toBe('Checked just now.');
  expect(freshnessText(state('failed', { checkedAt: '2026-11-21T09:59:50.000Z', error: 'a3doc wants MFA' }), 'a3doc', NOW))
    .toBe("Couldn't check a3doc (just now): a3doc wants MFA. Showing what's already here.");
  expect(freshnessText(state('unchecked'), 'a3doc', NOW)).toBe('Not checked against a3doc yet.');
  expect(freshnessText(null, 'a3doc', NOW)).toBeNull();
});

it('asks once when a folder opens, and again for the folder opened next', async () => {
  const fetcher = answers({ refresh: state('checked', { checkedAt: new Date().toISOString() }) });
  const onChecked = vi.fn();
  const view = render(<Harness onChecked={onChecked} />);
  await screen.findByText('Checked just now.');
  view.rerender(<Harness folderId="f2" onChecked={onChecked} />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(bodies(fetcher)).toEqual([['/source/folders/f1/refresh', { force: false }], ['/source/folders/f2/refresh', { force: false }]]);
  // Nothing changed in either: the listing is not read again.
  expect(onChecked).not.toHaveBeenCalled();
});

it('shows "Checking…" while a check runs elsewhere, asks again, and re-reads the folder when it ends', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const fetcher = answers({ refresh: state('checking'), retryAfterMs: 5_000 }, { refresh: state('checked', { checkedAt: new Date().toISOString(), changes: 2 }) });
  const onChecked = vi.fn();
  render(<Harness onChecked={onChecked} />);
  await screen.findByText('Checking a3doc for changes…');
  expect((screen.getByRole('button', { name: 'Check this folder in a3doc now' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  await screen.findByText('Checked just now.');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(onChecked).toHaveBeenCalledTimes(1);
});

it('checks on demand with the refresh button, and shows a failure quietly', async () => {
  const fetcher = answers(
    { refresh: state('checked', { checkedAt: new Date(Date.now() - 5 * 60_000).toISOString() }) },
    { refresh: state('failed', { checkedAt: new Date().toISOString(), error: 'a3doc wants MFA' }) },
  );
  render(<Harness onChecked={() => {}} />);
  await screen.findByText('Checked 5 min ago.');
  fireEvent.click(screen.getByRole('button', { name: 'Check this folder in a3doc now' }));
  await screen.findByText(/Couldn't check a3doc \(just now\): a3doc wants MFA/);
  expect(bodies(fetcher)[1]).toEqual(['/source/folders/f1/refresh', { force: true }]);
  // It is a status line, not an alert: the listing stays usable.
  expect(screen.queryByRole('alert')).toBeNull();
});

it('asks nothing for a folder that is not a source\'s, and says nothing when the worker cannot be reached', async () => {
  const fetcher = vi.fn(async () => { throw new TypeError('offline'); });
  vi.stubGlobal('fetch', fetcher);
  const view = render(<Harness enabled={false} onChecked={() => {}} />);
  expect(fetcher).not.toHaveBeenCalled();
  view.rerender(<Harness onChecked={() => {}} />);
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByTestId('folder-freshness')).toBeNull());
});

it('keeps asking for the window the server names, then stops spinning and lets the person ask again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const fetcher = answers({ refresh: state('checking'), retryAfterMs: 5_000, recheckWindowMs: 20_000 });
  render(<Harness onChecked={() => {}} />);
  await screen.findByText('Checking a3doc for changes…');
  const button = () => screen.getByRole('button', { name: 'Check this folder in a3doc now' }) as HTMLButtonElement;
  expect(button().disabled).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  // Asked at 0, 5, 10, 15 and 20 seconds; the next would land past the window.
  await screen.findByText('No answer from a3doc yet. Check now to ask again.');
  expect(fetcher).toHaveBeenCalledTimes(5);
  expect(button().disabled).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetcher).toHaveBeenCalledTimes(5);
  // Asking again is a forced check, and the page waits a whole window again.
  fireEvent.click(button());
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(6));
  expect(bodies(fetcher)[5]).toEqual(['/source/folders/f1/refresh', { force: true }]);
  await screen.findByText('Checking a3doc for changes…');
});

it('waits longer by default than the server keeps a taken request checking', () => {
  // TAKEN_RETRY_MS in @canopy/scope-drive is three minutes; the server's own window says so too.
  expect(DEFAULT_RECHECK_WINDOW_MS).toBeGreaterThan(3 * 60_000);
});

it('keeps the line and its button for a folder that has never been checked', async () => {
  answers({ refresh: state('unchecked') });
  render(<Harness onChecked={() => {}} />);
  await screen.findByText('Not checked against a3doc yet.');
  expect((screen.getByRole('button', { name: 'Check this folder in a3doc now' }) as HTMLButtonElement).disabled).toBe(false);
});
