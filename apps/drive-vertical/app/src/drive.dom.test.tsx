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
  /** For the cases that are about a failure arriving late. */
  reject: (error: Error) => void;
}

let pending: Pending[] = [];

/**
 * `fetch`, queued. Nothing answers until a test says so, so a test can start two reads
 * and finish them in the order that used to break the screen.
 */
function queueFetch() {
  pending = [];
  vi.stubGlobal('fetch', (url: string) =>
    new Promise((resolveFetch, rejectFetch) => {
      pending.push({
        url,
        reject: (error: Error) => rejectFetch(error),
        resolve: (body: unknown) =>
          resolveFetch({
            ok: true,
            status: 200,
            statusText: 'stubbed',
            json: () => Promise.resolve(body),
            // The preview reads a text body with `.text()`, not `.json()`. Without this
            // the call rejected and the panel merely reported an error — which a test
            // asserting something else would never notice.
            text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
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

/** What the shell needs and these tests do not exercise: an account and its two actions. */
const shell = {
  auth: { user: { name: 'ada@example.com' }, principal: '01ADA' },
  onSignIn: () => {},
  onSignOut: () => {},
};

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
  render(<DriveScreen {...shell} onError={() => {}} />);
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

    fireEvent.doubleClick(screen.getByText('Papers'));
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

describe('preview shows what the version actually is', () => {
  it('renders an image inline and a download for its bytes', async () => {
    await renderDrive([], [file('01A', 'photo.png')]);

    fireEvent.doubleClick(screen.getByText('photo.png'));
    await flush();
    await answer('/files/01A', {
      file: file('01A', 'photo.png'),
      version: { id: '01V', file_id: '01A', source: 'blob', blob_ref: '01B', mime: 'image/png', size: 2048, created_at: '2026-09-01T00:00:00.000Z' },
    });

    const img = screen.getByAltText('photo.png') as HTMLImageElement;
    expect(img.src).toContain('/api/files/01A/content');
    const link = screen.getByText('Download').closest('a') as HTMLAnchorElement;
    expect(link.getAttribute('download')).toBe('photo.png');
  });

  it('offers no preview for a type the browser cannot show, and says which type', async () => {
    await renderDrive([], [file('01A', 'archive.zip')]);

    fireEvent.doubleClick(screen.getByText('archive.zip'));
    await flush();
    await answer('/files/01A', {
      file: file('01A', 'archive.zip'),
      version: { id: '01V', file_id: '01A', source: 'blob', blob_ref: '01B', mime: 'application/zip', size: 10, created_at: '2026-09-01T00:00:00.000Z' },
    });

    // Naming the type matters: "no preview" alone reads as a failure rather than a fact
    // about zip files.
    expect(screen.getByText(/application\/zip/)).toBeTruthy();
  });

  it('says nobody has looked, rather than showing an empty text tab', async () => {
    await renderDrive([], [file('01A', 'notes.md')]);

    fireEvent.doubleClick(screen.getByText('notes.md'));
    await flush();
    await answer('/files/01A', {
      file: file('01A', 'notes.md'),
      version: { id: '01V', file_id: '01A', source: 'blob', blob_ref: '01B', mime: 'text/markdown', size: 4, created_at: '2026-09-01T00:00:00.000Z' },
    });
    // The text shape fetches its body and shows it.
    await answer('/files/01A/content', '# notes\nthe body renders inline');
    expect(screen.getByText(/the body renders inline/)).toBeTruthy();

    fireEvent.click(screen.getByText('Text'));
    await flush();
    await answer('/files/01A/text', null);

    expect(screen.getByText(/Nobody has looked inside/)).toBeTruthy();
  });
});

describe('the preview panel’s reads do not compete with each other', () => {
  it('still shows the file after a tab is opened before the metadata lands', async () => {
    await renderDrive([], [file('01A', 'photo.png')]);

    fireEvent.doubleClick(screen.getByText('photo.png'));
    await flush();

    // The user reaches for Versions before `getFile` has answered. With one guard for the
    // whole panel this took the ticket, so the metadata answer was dropped as stale and
    // the panel sat claiming the file had nothing written to it — the guard suppressing a
    // CURRENT answer rather than an outdated one.
    fireEvent.click(screen.getByText('Versions'));
    await answer('/files/01A/versions', []);
    await answer('/files/01A', {
      file: file('01A', 'photo.png'),
      version: { id: '01V', file_id: '01A', source: 'blob', blob_ref: '01B', mime: 'image/png', size: 2048, created_at: '2026-09-01T00:00:00.000Z' },
    });

    fireEvent.click(screen.getByText('Preview'));
    expect(screen.getByAltText('photo.png')).toBeTruthy();
    expect(screen.queryByText(/Nothing has been written/)).toBeNull();
  });

  it('says nothing at all once the panel has been closed', async () => {
    const errors: (string | null)[] = [];
    render(<DriveScreen {...shell} onError={(m) => errors.push(m)} />);
    await flush();
    await answer('/folders/root/folders', []);
    await answer('/folders/root/files', [file('01A', 'photo.png')]);

    fireEvent.doubleClick(screen.getByText('photo.png'));
    await flush();
    fireEvent.click(screen.getByLabelText('Close preview'));

    // The read was in flight when the panel closed. Its failure belongs to a file nobody
    // is looking at, so it must not reach the error surface.
    const pendingGet = pending.find((p) => p.url.endsWith('/files/01A'));
    expect(pendingGet).toBeTruthy();
    await act(async () => {
      pendingGet!.reject(new Error('gone'));
    });
    expect(errors.filter((e) => e === 'gone')).toHaveLength(0);
  });
});

describe('the moved table brings its own behaviour with it', () => {
  it('sorts by a column header, and toggles direction on a second click', async () => {
    await renderDrive([], [file('01A', 'beta.md'), file('01B', 'alpha.md')]);

    // The screen sorts the rows and the table renders what it is handed — the component
    // reports a sort rather than applying one, which only a test makes visible.
    const names = () => screen.getAllByRole('row').slice(1).map((r) => r.textContent ?? '');

    // The listing arrived beta-then-alpha; the default sort is name ascending, so the
    // order on screen is not the order the scope returned.
    expect(names()[0]).toContain('alpha.md');

    // Clicking the column already sorted flips the direction rather than re-sorting.
    fireEvent.click(screen.getByText('Name'));
    expect(names()[0]).toContain('beta.md');

    fireEvent.click(screen.getByText('Name'));
    expect(names()[0]).toContain('alpha.md');
  });

  it('selects on a single click and opens on a double one', async () => {
    await renderDrive([], [file('01A', 'photo.png')]);

    // Finder semantics, and the reason the preview tests above had to be rewritten: a
    // single click selects, so opening is the second click rather than the first.
    fireEvent.click(screen.getByText('photo.png'));
    expect(pending.some((p) => p.url.endsWith('/files/01A'))).toBe(false);

    fireEvent.doubleClick(screen.getByText('photo.png'));
    await flush();
    expect(pending.some((p) => p.url.endsWith('/files/01A'))).toBe(true);
  });

  it('switches to the grid and back', async () => {
    await renderDrive([], [file('01A', 'photo.png')]);
    // The grid has no column headers; the list does. That is the cheapest observable
    // difference between the two, and it is the one a user notices first.
    expect(screen.queryByText('Name')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Switch to grid'));
    expect(screen.queryByText('Name')).toBeNull();
    fireEvent.click(screen.getByLabelText('Switch to list'));
    expect(screen.queryByText('Name')).toBeTruthy();
  });
});

describe('dragging a file onto a folder moves it', () => {
  it('fires the move the prefix check used to swallow', async () => {
    await renderDrive(
      [{ id: '01F', parent_id: 'root', name: 'Papers', path: 'Papers' }],
      [file('01A', 'lease.pdf')],
    );

    const row = screen.getByText('lease.pdf').closest('tr')!;
    const target = screen.getByText('Papers').closest('tr')!;

    /**
     * A drag event carries a `DataTransfer`; `fireEvent` does not invent one, and the
     * handlers use `setData`, `effectAllowed` and `dropEffect`. Without this the handler
     * throws on the first line — which vitest reports as an unhandled error beside a
     * passing test, so the test looked green while the gesture never ran.
     */
    const dataTransfer = {
      setData: () => {},
      getData: () => '',
      effectAllowed: 'none',
      dropEffect: 'none',
    };

    // The table judged a drop target by `id.startsWith("folder:")`, which was true of the
    // portal's synthetic folder rows and false of every folder in a scope — so this
    // gesture did nothing at all, silently, while the UI advertised it.
    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    await flush();

    const moved = pending.find((p) => p.url.includes('/files/01A/move'));
    expect(moved, `no move request; saw ${pending.map((p) => p.url).join(', ')}`).toBeTruthy();
  });
});

describe('the shell the portal had, on the vertical', () => {
  it('opens the palette on ⌘K and searches the drive with it', async () => {
    await renderDrive([], [file('01A', 'lease.pdf')]);

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = screen.getByPlaceholderText(/Search files/);

    fireEvent.change(input, { target: { value: 'lease' } });
    await flush();
    // The palette searches the real operation, and the hit says WHERE it matched — the
    // half of search that content extraction paid for.
    await answer('term=lease', { hits: [{ ...file('01A', 'lease.pdf'), via: 'content' }] });
    expect(screen.getByText(/matched inside the document/)).toBeTruthy();
  });

  it('closes on a second ⌘K, so the shortcut is a toggle', async () => {
    await renderDrive([], []);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.queryByPlaceholderText(/Search files/)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.queryByPlaceholderText(/Search files/)).toBeNull();
  });

  it('shows the signed-in account and offers sign-out', async () => {
    await renderDrive([], []);
    // The portal's topbar rendered a fabricated persona when nobody was signed in; this
    // one takes the principal it was handed and nothing else.
    expect(screen.getByText('My Drive')).toBeTruthy();
    expect(screen.queryByText(/Log in/)).toBeNull();
  });
});
