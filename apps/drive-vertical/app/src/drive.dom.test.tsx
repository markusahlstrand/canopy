/**
 * The three ordering bugs this screen has actually had (#81).
 *
 * Every one of them reached review rather than CI, because nothing here rendered under
 * test: the client's URLs were asserted, the guard's arithmetic was asserted, and the
 * wiring between them — which is where all three lived — was not. Each test below is
 * written to fail against the code as it was before its fix, which is the only way to
 * know a race test is testing anything.
 *
 * The technique is a `fetch` whose answers resolve **on command**. A race is an ordering,
 * so a test that cannot choose the order cannot describe one; `await waitFor` on a real
 * promise chain would only ever observe the order the runtime happened to pick.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DriveScreen } from './drive';
import { selectSite } from './api';

/** One pending answer, and the handle a test resolves it with. */
interface Pending {
  url: string;
  resolve: (body: unknown) => void;
}

let pending: Pending[] = [];

/**
 * `fetch`, queued. Nothing answers until a test says so, so a test can start two reads
 * and finish them in the order that used to break the screen.
 */
function queueFetch() {
  pending = [];
  vi.stubGlobal('fetch', (url: string) =>
    new Promise((resolveFetch) => {
      pending.push({
        url,
        resolve: (body: unknown) =>
          resolveFetch({
            ok: true,
            status: 200,
            statusText: 'stubbed',
            json: () => Promise.resolve(body),
          } as Response),
      });
    }),
  );
}

/**
 * Let the screen's scheduled reads start.
 *
 * Every read goes through a `setTimeout` — 0 for a listing, 200ms for a search — so with
 * fake timers nothing is even requested until time moves. Advancing is therefore part of
 * arranging the test, not part of what it asserts.
 */
async function flush(ms = 250): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

/** Answer the first queued request whose URL matches, leaving the others pending. */
async function answer(match: string, body: unknown): Promise<void> {
  const i = pending.findIndex((p) => p.url.includes(match));
  expect(i, `no pending request matching ${match}; saw ${pending.map((p) => p.url).join(', ')}`).toBeGreaterThan(-1);
  const [target] = pending.splice(i, 1);
  await act(async () => {
    target!.resolve(body);
  });
}

const file = (id: string, name: string) => ({
  id,
  folder_id: 'root',
  name,
  current_version_id: '01V',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  state: 'live',
  deleted_at: null,
});

beforeEach(() => {
  queueFetch();
  /**
   * A FULLY manual clock — no `shouldAdvanceTime`.
   *
   * With it, the fake clock advances alongside real time, so the wall-clock milliseconds
   * spent inside `answer`'s `await act(...)` could carry the timer past 200ms and start
   * the next search read. That read takes a ticket and invalidates the older request all
   * by itself, which would make the debounce-window test below pass whether or not the
   * fix it exists for is present — the exact false positive this file was written to
   * avoid, reintroduced through the clock instead of the promise order.
   *
   * Manual means only `flush()` can leave the debounce window, so the window is a fact
   * about the test rather than about how long the machine took.
   */
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  selectSite(null);
});

/** The screen starts by reading the root folder; answer that and get out of the way. */
async function renderDrive(folders: unknown[] = [], files: unknown[] = []): Promise<void> {
  render(<DriveScreen onError={() => {}} />);
  await flush();
  await answer('/folders/root/folders', folders);
  await answer('/folders/root/files', files);
}

describe('a stale search answer never reaches the screen', () => {
  it('drops the first term’s hits when the term has moved on', async () => {
    await renderDrive();
    const box = screen.getByLabelText('Search this space');

    fireEvent.change(box, { target: { value: 'lea' } });
    await flush();
    expect(pending.some((p) => p.url.includes('term=lea'))).toBe(true);

    // The second term, typed before the first answer lands. THIS is the interleaving:
    // debouncing cancelled the pending timer, not the request already in flight.
    fireEvent.change(box, { target: { value: 'lease' } });
    await flush();

    // The older request answers LAST, which is the whole point.
    await answer('term=lease', { hits: [file('01B', 'lease.pdf')] });
    await answer('term=lea', { hits: [file('01A', 'leaflet.pdf')] });

    expect(screen.getByText('lease.pdf')).toBeTruthy();
    expect(screen.queryByText('leaflet.pdf')).toBeNull();
  });

  it('drops an answer that lands inside the debounce window', async () => {
    await renderDrive();
    const box = screen.getByLabelText('Search this space');

    fireEvent.change(box, { target: { value: 'lea' } });
    await flush();

    // The second keystroke, and then NO flush: we are inside the 200ms before the next
    // request is even scheduled. This is the window a per-read ticket left open — the
    // first request still held the current one, so its answer rendered hits for a term
    // the box no longer holds. Answering here is the whole test; the earlier one flushes
    // first and so never reaches this state.
    fireEvent.change(box, { target: { value: 'lease' } });
    await answer('term=lea', { hits: [file('01A', 'leaflet.pdf')] });

    expect(screen.queryByText('leaflet.pdf')).toBeNull();

    // And the real answer still arrives afterwards.
    await flush();
    await answer('term=lease', { hits: [file('01B', 'lease.pdf')] });
    expect(screen.getByText('lease.pdf')).toBeTruthy();
  });

  it('asks nothing at all below the minimum term length', async () => {
    await renderDrive();
    fireEvent.change(screen.getByLabelText('Search this space'), { target: { value: 'a' } });
    await flush(500);
    expect(pending.filter((p) => p.url.includes('/search'))).toHaveLength(0);
  });
});

describe('an action refreshes the folder on screen, not the one it started in', () => {
  it('leaves the second folder’s listing in place after a rename in the first', async () => {
    // "Papers" has to be in the root listing for a click into it to exist.
    await renderDrive(
      [
        { id: '01F', parent_id: 'root', name: 'Papers', path: 'Papers' },
        { id: '01G', parent_id: 'root', name: 'Notes', path: 'Notes' },
      ],
      [],
    );

    fireEvent.click(screen.getByText('Papers'));
    await flush();
    await answer('/folders/01F/folders', []);
    await answer('/folders/01F/files', [file('01A', 'lease.pdf')]);
    expect(screen.getByText('lease.pdf')).toBeTruthy();

    // A write starts in Papers. "New folder" rather than the row menu because the menu
    // is a Radix trigger that wants real pointer events, and the race under test is about
    // WHICH refresh an action runs — not about which control started it.
    fireEvent.click(screen.getByText('New folder'));
    fireEvent.change(screen.getByLabelText('New folder'), { target: { value: 'Drafts' } });
    fireEvent.click(screen.getByText('Create'));

    // …and the user leaves for the root before it answers.
    fireEvent.click(screen.getByText('My Drive'));
    await flush();
    await answer('/folders/root/folders', [{ id: '01G', parent_id: 'root', name: 'Notes', path: 'Notes' }]);
    await answer('/folders/root/files', [file('01C', 'at-the-root.md')]);

    // Now the write lands. Its follow-up read must be of the ROOT — the folder on screen —
    // and must not invalidate the root's own read on the way. Before the fix it read
    // 01F and claimed the ticket, so Papers' contents rendered under "My Drive".
    await answer('/folders/01F/folders', { id: '01H', parent_id: '01F', name: 'Drafts', path: 'Papers/Drafts' });
    await flush();
    await answer('/folders/root/folders', [{ id: '01G', parent_id: 'root', name: 'Notes', path: 'Notes' }]);
    await answer('/folders/root/files', [file('01C', 'at-the-root.md')]);

    // A direct assertion rather than `waitFor`: the clock is manual, so `waitFor` would
    // poll a timer nothing advances and time out. It also is not needed — `answer` wraps
    // each resolution in `act`, so every state update it causes has already flushed.
    expect(screen.getByText('at-the-root.md')).toBeTruthy();
    expect(screen.queryByText('renamed.pdf')).toBeNull();
    expect(screen.queryByText('lease.pdf')).toBeNull();
  });
});
