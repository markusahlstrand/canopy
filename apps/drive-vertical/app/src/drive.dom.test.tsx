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
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';
import { DriveScreen } from './drive';
import { currentSite, selectSite } from './api';
import { indexedMirror } from './scope-mirror';
import * as liveUpdates from './live-updates';

/** One pending answer, and the handle a test resolves it with. */
interface Pending {
  url: string;
  /** The method, so a test can tell a grant from a withdrawal of the same path. */
  method: string;
  /** The body as sent, for the operations whose subject is IN it rather than in the URL. */
  body: string | null;
  resolve: (body: unknown, status?: number, headers?: HeadersInit) => void;
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
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
    new Promise((resolveFetch, rejectFetch) => {
      pending.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
        reject: (error: Error) => rejectFetch(error),
        resolve: (body: unknown, status = 200, headers?: HeadersInit) =>
          resolveFetch({
            ok: status < 400,
            status,
            statusText: 'stubbed',
            headers: new Headers(headers),
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
  await answerWith(match, 200, body);
}

/** The same, with a status — for the paths that are about being refused. */
async function answerWith(match: string, status: number, body: unknown, headers?: HeadersInit): Promise<void> {
  const i = pending.findIndex((p) => p.url.includes(match));
  expect(i, `no pending request matching ${match}; saw ${pending.map((p) => p.url).join(', ')}`).toBeGreaterThan(-1);
  const [target] = pending.splice(i, 1);
  await act(async () => {
    target!.resolve(body, status, headers);
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
  localStorage.removeItem('canopy.drive.view');
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
  /**
   * Spies too, not just stubbed globals.
   *
   * Two tests here make `Storage.prototype.setItem` throw to stand in for blocked storage.
   * Vitest does not undo a spy between tests on its own, so without this the next test
   * runs in a private window it never asked for — which is not a failure, it is a
   * different test quietly passing for the wrong reason.
   */
  vi.restoreAllMocks();
  selectSite(null);
  window.history.replaceState(null, '', '/');
});

/**
 * The screen starts by reading the root folder and the space list; answer both and get
 * out of the way. The rail's list is answered even when a test does not care, because an
 * unanswered read is a component stuck on its loading state for the whole test.
 */
async function renderDrive(
  folders: unknown[] = [],
  files: unknown[] = [],
  sites: unknown[] = [],
): Promise<void> {
  render(<DriveScreen {...shell} onError={() => {}} />);
  await flush();
  await answer('/api/sites', sites);
  await answer('/folders/root/folders', folders);
  await answer('/folders/root/files', files);
}

/** Open the rail's New menu, which is a Radix trigger: it answers the keyboard, not `click`. */
function newMenu(): void {
  fireEvent.keyDown(screen.getByText('New'), { key: 'Enter' });
}

/** The rail, to address it apart from the topbar — both say "My Drive". */
const rail = () => within(screen.getByRole('complementary'));

/**
 * Open the account menu in the topbar. Radix again: it answers the keyboard, not `click`.
 * Every assertion about what is IN this menu has to prove the menu opened first, or a
 * missing item and a closed menu read identically.
 */
function accountMenu(): void {
  fireEvent.keyDown(within(screen.getByRole('banner')).getByText('AE'), { key: 'Enter' });
  expect(screen.getByText('Sign out')).toBeTruthy();
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

    // A write starts in Papers. "New folder" rather than the row menu because the row's
    // menu wants real pointer events, and the race under test is about WHICH refresh an
    // action runs — not about which control started it.
    newMenu();
    fireEvent.click(screen.getByText('New folder'));
    fireEvent.change(screen.getByLabelText('New folder'), { target: { value: 'Drafts' } });
    fireEvent.click(screen.getByText('Create'));

    // …and the user leaves for the root before it answers.
    fireEvent.click(rail().getByText('My Drive'));
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

describe('live refreshes', () => {
  function watch() {
    let notify = () => {};
    const stop = vi.fn();
    vi.spyOn(liveUpdates, 'watchDriveChanges').mockImplementation((onChange) => {
      notify = onChange;
      return stop;
    });
    return { notify: () => act(() => notify()), stop };
  }

  it('finishes slow reads while notifications continue and coalesces one trailing read', async () => {
    const live = watch();
    await renderDrive();
    live.notify();
    for (let i = 0; i < 5; i++) {
      await flush(150);
      live.notify();
    }
    expect(pending.filter((p) => p.url.includes('/folders/root/files'))).toHaveLength(1);

    await answer('/folders/root/folders', []);
    await answer('/folders/root/files', [file('01A', 'first.txt')]);
    expect(screen.getByText('first.txt')).toBeTruthy();
    expect(pending.filter((p) => p.url.includes('/folders/root/files'))).toHaveLength(1);

    await answer('/folders/root/folders', []);
    await answer('/folders/root/files', [file('01B', 'latest.txt')]);
    expect(screen.getByText('latest.txt')).toBeTruthy();
    expect(screen.queryByText('first.txt')).toBeNull();
    expect(pending.filter((p) => p.url.includes('/folders/root/'))).toHaveLength(0);
    expect((screen.getByLabelText('Refresh') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps navigation authoritative and refreshes the current folder on the trailing read', async () => {
    const live = watch();
    await renderDrive([{ id: '01F', parent_id: 'root', name: 'Papers', path: 'Papers' }]);
    live.notify();
    live.notify();
    fireEvent.doubleClick(screen.getByText('Papers'));
    await flush();
    await answer('/folders/01F/folders', []);
    await answer('/folders/01F/files', [file('01B', 'papers.txt')]);

    await answer('/folders/root/folders', []);
    await answer('/folders/root/files', [file('01A', 'stale-root.txt')]);
    expect(screen.queryByText('stale-root.txt')).toBeNull();
    expect(screen.getByText('papers.txt')).toBeTruthy();
    expect(pending.filter((p) => p.url.includes('/folders/root/'))).toHaveLength(0);
    expect(pending.filter((p) => p.url.includes('/folders/01F/files'))).toHaveLength(1);

    await answer('/folders/01F/folders', []);
    await answer('/folders/01F/files', [file('01C', 'updated-papers.txt')]);
    expect(screen.getByText('updated-papers.txt')).toBeTruthy();
  });

  it('cancels the queued trailing refresh when the screen unmounts', async () => {
    const live = watch();
    await renderDrive();
    live.notify();
    live.notify();
    cleanup();
    expect(live.stop).toHaveBeenCalledTimes(1);
    await answer('/folders/root/folders', []);
    await answer('/folders/root/files', []);
    expect(pending.filter((p) => p.url.includes('/folders/root/'))).toHaveLength(0);
  });
});

describe('offline metadata from the scope event mirror', () => {
  it('shows saved folder rows after a network failure and keeps Refresh available', async () => {
    vi.spyOn(indexedMirror, 'folder').mockResolvedValue({
      folders: [{ id: '01F', parent_id: 'root', name: 'Saved folder', path: 'Saved folder' }],
      files: [file('01A', 'saved.txt')],
    });
    await renderDrive();

    fireEvent.click(screen.getByLabelText('Refresh'));
    await flush();
    const request = pending.find((p) => p.url.includes('/folders/root/files'));
    expect(request).toBeTruthy();
    await act(async () => request!.reject(new TypeError('network unavailable')));

    expect(screen.getByRole('status').textContent).toContain('Offline');
    expect(screen.getByText('Saved folder')).toBeTruthy();
    expect(screen.getByText('saved.txt')).toBeTruthy();
    expect((screen.getByLabelText('Refresh') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText('Search this space') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('preview shows what the version actually is', () => {
  it('downloads each stored historical version in the selected space', async () => {
    selectSite('family');
    await renderDrive([], [file('01A', 'photo.png')]);
    fireEvent.doubleClick(screen.getByText('photo.png'));
    await flush();
    const current = { id: '01V', file_id: '01A', source: 'blob', blob_ref: '01B', mime: 'image/png', size: 2048, created_at: '2026-09-01T00:00:00.000Z' };
    await answer('/files/01A', { file: file('01A', 'photo.png'), version: current });
    fireEvent.click(screen.getByText('Versions'));
    await answer('/files/01A/versions', [
      current,
      { ...current, id: '01OLD', blob_ref: '01OLD-BLOB', created_at: '2026-08-01T00:00:00.000Z' },
      { ...current, id: '01EXTERNAL', source: 'external', blob_ref: null },
      { ...current, id: '01MISSING', blob_ref: null },
    ]);
    const panel = screen.getByRole('complementary', { name: 'Preview' });
    const links = within(panel).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/api/files/01A/content?site=family',
      '/api/files/01A/versions/01V/content?site=family',
      '/api/files/01A/versions/01OLD/content?site=family',
    ]);
    for (const link of links) expect(link.getAttribute('download')).toBe('photo.png');
    expect(within(panel).getByText('current')).toBeTruthy();
    expect(within(panel).getByText('in a connected source')).toBeTruthy();
  });

  it('renders an image inline and a download for its bytes', async () => {
    await renderDrive([], [file('01A', 'photo.png')]);

    fireEvent.doubleClick(screen.getByText('photo.png'));
    await flush();
    await answer('/files/01A', {
      file: file('01A', 'photo.png'),
      version: { id: '01V', file_id: '01A', source: 'blob', blob_ref: '01B', mime: 'image/png', size: 2048, created_at: '2026-09-01T00:00:00.000Z' },
    });

    const viewer = document.querySelector('canopy-image-viewer');
    const img = viewer?.shadowRoot?.querySelector('img');
    expect(img?.alt).toBe('photo.png');
    expect(img).toBeTruthy();
    expect(img!.src).toContain('/api/files/01A/content');
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
    await answer('/files/01A/versions/01V/content', '# notes\nthe body renders inline');
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
    expect(document.querySelector('canopy-image-viewer')?.shadowRoot?.querySelector('img')?.alt).toBe('photo.png');
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
  it('moves folders and refuses dropping one onto itself', async () => {
    await renderDrive([
      { id: '01F', parent_id: 'root', name: 'Papers', path: 'Papers' },
      { id: '01D', parent_id: 'root', name: 'Archive', path: 'Archive' },
    ]);
    const row = screen.getByText('Papers').closest('tr')!;
    const dataTransfer = { setData: () => {}, effectAllowed: 'none', dropEffect: 'none' };
    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.drop(row, { dataTransfer });
    expect(pending.some((p) => p.url.endsWith('/01F/move'))).toBe(false);
    fireEvent.drop(screen.getByText('Archive').closest('tr')!, { dataTransfer });
    expect(pending.find((p) => p.url.endsWith('/folders/01F/move'))?.body)
      .toBe(JSON.stringify({ parentId: '01D' }));
  });


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

describe('move destination picker', () => {
  async function pick(items: unknown[] = [file('01A', 'lease.pdf')], selectAll = false) {
    await renderDrive([], items);
    if (selectAll) fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    fireEvent.contextMenu(screen.getByText('lease.pdf').closest('tr')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move' }));
    await answer('/folders/root/folders', [
      { id: '01D', parent_id: 'root', name: 'Archive', path: 'Archive' },
    ]);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Move here' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await answer('/folders/01D/folders', []);
    return dialog;
  }

  it('moves a root file into a chosen destination instead of silently doing nothing', async () => {
    const dialog = await pick();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here' }));
    expect(pending.find((p) => p.url.endsWith('/files/01A/move'))?.body)
      .toBe(JSON.stringify({ folderId: '01D' }));
    await answer('/files/01A/move', { ...file('01A', 'lease.pdf'), folder_id: '01D' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await answer('/folders/root/folders', []);
    await answer('/folders/root/files', []);
    expect(screen.queryByText('lease.pdf')).toBeNull();
  });

  it('cancelling sends no move', async () => {
    const dialog = await pick();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(pending.some((p) => p.url.endsWith('/move'))).toBe(false);
  });

  it('keeps a name conflict visible and allows choosing another destination', async () => {
    const dialog = await pick();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here' }));
    await answerWith('/files/01A/move', 409, { error: 'name already exists' });
    await answer('/folders/root/folders', []);
    await answer('/folders/root/files', [file('01A', 'lease.pdf')]);
    expect(within(dialog).getByRole('alert').textContent).toContain('1 remaining');
    expect(screen.getByText('lease.pdf')).toBeTruthy();
  });

  it('moves a selection and retries only the items that failed', async () => {
    const items = [file('01A', 'lease.pdf'), file('01B', 'other.pdf')];
    const dialog = await pick(items, true);
    expect(within(dialog).getByText('Move 2 items')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here' }));
    await answer('/files/01A/move', { ...items[0], folder_id: '01D' });
    await answerWith('/files/01B/move', 409, { error: 'name already exists' });
    await answer('/folders/root/folders', []);
    await answer('/folders/root/files', [items[1]]);
    expect(within(dialog).getByRole('alert').textContent).toContain('1 moved; 1 remaining');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here' }));
    expect(pending.filter((p) => p.url.endsWith('/move')).map((p) => p.url))
      .toEqual(['/api/files/01B/move']);
  });
});

describe('shared-folder discovery', () => {
  it('lists direct shares and opens a nested folder by its identity', async () => {
    await renderDrive([], [file('01A', 'lease.pdf')]);
    fireEvent.click(screen.getByRole('button', { name: 'Shared with me' }));
    await flush();
    await answer('/folders/shared-with-me', { folders: [
      { id: '01N', parent_id: '01P', path: 'Papers/Leases', name: 'Leases' },
    ] });
    expect(screen.queryByText('lease.pdf')).toBeNull();
    fireEvent.doubleClick(screen.getByText('Leases'));
    await flush();
    expect(pending.some((p) => p.url.includes('/folders/01N/files'))).toBe(true);
    await answer('/folders/01N/folders', []);
    await answer('/folders/01N/files', [file('01L', 'shared.pdf')]);
    expect(screen.getByText('shared.pdf')).toBeTruthy();
    expect(screen.getAllByText('Papers/Leases').length).toBeGreaterThan(0);
  });
});

describe('Trash actions', () => {
  it('offers Restore instead of live-file actions and removes the restored row', async () => {
    await renderDrive();
    fireEvent.click(screen.getByRole('button', { name: 'Trash' }));
    await flush();
    await answer('/api/trash', [{ ...file('01A', 'lease.pdf'), state: 'trashed' }]);
    fireEvent.contextMenu(screen.getByText('lease.pdf').closest('tr')!);
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Restore']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restore' }));
    const restore = pending.find((p) => p.url.endsWith('/files/01A/restore'));
    expect(restore?.method).toBe('POST');
    await answer('/files/01A/restore', file('01A', 'lease.pdf'));
    await answer('/api/trash', []);
    expect(screen.queryByText('lease.pdf')).toBeNull();
    expect(screen.getByText('Trash is empty')).toBeTruthy();
  });

  it('offers the same Restore action from a grid card', async () => {
    await renderDrive();
    fireEvent.click(screen.getByRole('button', { name: 'Trash' }));
    await flush();
    await answer('/api/trash', [{ ...file('01A', 'lease.pdf'), state: 'trashed' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to grid' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions for lease.pdf' }), { button: 0, ctrlKey: false });
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Restore']);
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

  it('identifies description/label matches in the command palette', async () => {
    await renderDrive([], []);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.change(screen.getByPlaceholderText(/Search files/), { target: { value: 'insurance' } });
    await flush();
    await answer('term=insurance', { hits: [{ ...file('01A', 'agreement.pdf'), via: 'metadata' }] });
    expect(screen.getByText('matched in description or labels')).toBeTruthy();
    fireEvent.click(screen.getByText('agreement.pdf'));
    await flush();
    expect(pending.some(request => request.url.endsWith('/files/01A'))).toBe(true);
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
    // one takes the principal it was handed and nothing else. Scoped to the header,
    // because the rail says "My Drive" too.
    expect(screen.getByRole('banner').textContent).toContain('My Drive');
    expect(screen.queryByText(/Log in/)).toBeNull();
  });
});

describe('the mobile drive shell and empty views', () => {
  it('refreshes an already empty destination when its rail item is chosen again', async () => {
    await renderDrive();
    fireEvent.click(rail().getByText('My Drive'));
    expect(pending.some((p) => p.url.includes('/folders/root/folders'))).toBe(true);
    await answer('/folders/root/folders', []);
    await answer('/folders/root/files', []);
    expect(screen.getByText('Your drive is empty')).toBeTruthy();

    fireEvent.click(rail().getByText('Trash'));
    await flush();
    await answer('/trash', []);
    fireEvent.click(rail().getByText('Trash'));
    expect(pending.some((p) => p.url.includes('/trash'))).toBe(true);
    await answer('/trash', []);
    expect(screen.getByText('Trash is empty')).toBeTruthy();
  });

  it('opens the space and view rail from the compact header without another site read', async () => {
    await renderDrive();
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    const sheet = screen.getByRole('dialog', { name: 'Drive navigation' });
    expect(within(sheet).getByText('My Drive')).toBeTruthy();
    expect(pending.filter((p) => p.url.includes('/api/sites'))).toHaveLength(0);

    fireEvent.click(within(sheet).getByText('Trash'));
    await flush();
    await answer('/trash', []);
    expect(screen.getByText('Trash is empty')).toBeTruthy();
    expect(screen.getByRole('banner').textContent).toContain('Trash');
  });

  it('explains an empty drive and gives actions that exist', async () => {
    await renderDrive();
    expect(screen.getByText('Your drive is empty')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('status')).getByText('New folder'));
    expect(screen.getByRole('dialog', { name: '' })).toBeTruthy();
    expect(screen.getByLabelText('New folder')).toBeTruthy();
  });

  it('distinguishes a short search from a completed search with no matches', async () => {
    await renderDrive();
    const box = screen.getByLabelText('Search this space');
    fireEvent.change(box, { target: { value: 'a' } });
    await flush();
    expect(screen.getByText('Enter at least 2 characters to find files.')).toBeTruthy();

    fireEvent.change(box, { target: { value: 'absent' } });
    await flush();
    await answer('term=absent', { hits: [] });
    expect(screen.getByText('No matches for “absent”')).toBeTruthy();
  });

  it('opens a file with one tap at the mobile breakpoint', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 767px)', media: query,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
    }));
    await renderDrive([], [file('01A', 'lease.pdf')]);
    expect(screen.getByRole('button', { name: 'Actions for lease.pdf' })).toBeTruthy();
    fireEvent.click(screen.getByText('lease.pdf'));
    expect(screen.getByRole('complementary', { name: 'Preview' })).toBeTruthy();
    expect(pending.some((p) => p.url.endsWith('/files/01A'))).toBe(true);
  });

  it('closes a mobile preview when navigating to another view', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 767px)', media: query,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
    }));
    await renderDrive([], [file('01A', 'lease.pdf')]);
    fireEvent.click(screen.getByText('lease.pdf'));
    expect(screen.getByRole('complementary', { name: 'Preview' })).toBeTruthy();
    fireEvent.click(within(screen.getAllByRole('complementary')[0]!).getByText('Trash'));
    expect(screen.queryByRole('complementary', { name: 'Preview' })).toBeNull();
  });

  it('selects a mobile grid card without opening it', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 767px)', media: query,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
    }));
    await renderDrive([], [file('01A', 'lease.pdf')]);
    fireEvent.click(screen.getByLabelText('Switch to grid'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select lease.pdf' }));
    expect(screen.getByRole('checkbox', { name: 'Select lease.pdf' }).getAttribute('data-state')).toBe('checked');
    expect(screen.queryByRole('complementary', { name: 'Preview' })).toBeNull();
  });
});

describe('the palette does not hand back the wrong thing', () => {
  it('drops the previous query’s hits the moment the query changes', async () => {
    await renderDrive([], []);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = screen.getByPlaceholderText(/Search files/);

    fireEvent.change(input, { target: { value: 'lease' } });
    await flush();
    await answer('term=lease', { hits: [{ ...file('01A', 'lease.pdf'), via: 'name' }] });
    expect(screen.getByText('lease.pdf')).toBeTruthy();

    // cmdk's item `value` embeds the CURRENT query, so a hit left over from the previous
    // one stays selectable and opens a file nobody searched for.
    fireEvent.change(input, { target: { value: 'invoice' } });
    expect(screen.queryByText('lease.pdf')).toBeNull();
  });

  it('enters a folder chosen in the palette instead of previewing it', async () => {
    await renderDrive([{ id: '01F', parent_id: 'root', name: 'Papers', path: 'Papers' }], []);

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    // Two "Papers" now exist — one in the table behind the dialog, one in the palette's
    // zero-query list. Scope to the dialog, which is the thing under test.
    const palette = screen.getByRole('dialog');
    fireEvent.click(within(palette).getByText('Papers'));
    await flush();

    // Navigation reads the folder; a preview would have asked `get-file` for a folder id.
    expect(pending.some((p) => p.url.includes('/folders/01F/files'))).toBe(true);
    expect(pending.some((p) => p.url.endsWith('/files/01F'))).toBe(false);
  });

});

describe('the rail is how you change space', () => {
  it('lists every space and marks the one in view', async () => {
    // The guarantee the topbar's `<select>` used to carry: a person in several spaces can
    // always reach the others. It moved here, so the test moved with it.
    await renderDrive([], [], [
      { slug: 'home', name: 'Home', current: true },
      { slug: 'family', name: 'Family', current: false },
    ]);

    const spaces = within(screen.getByRole('navigation', { name: 'Spaces' }));
    expect(spaces.getByText('Home')).toBeTruthy();
    expect(spaces.getByText('Family')).toBeTruthy();
    // `current` comes from the server because only the worker knows which slug the
    // hostname resolved to; the rail renders it and does not guess.
    expect(spaces.getByText('Home').closest('button')?.getAttribute('aria-current')).toBe('true');
    expect(spaces.getByText('Family').closest('button')?.getAttribute('aria-current')).toBeNull();
  });

  it('persists the space it was told to select', async () => {
    await renderDrive([], [], [
      { slug: 'home', name: 'Home', current: true },
      { slug: 'family', name: 'Family', current: false },
    ]);

    // Selecting is persist-then-reload, and the persist is the half that has to be true
    // by the time the new page reads it. The reload itself shows up as jsdom's
    // "Not implemented: navigation" line — there is no way to stub `location.reload`,
    // and the selection is what a wrong answer would get wrong.
    fireEvent.click(screen.getByText('Family'));
    expect(currentSite()).toBe('family');

    // The space you are already in is not a navigation: nothing is written, and nothing
    // reloads. Clicking it used to mean a pointless round trip through a whole page load.
    fireEvent.click(screen.getByText('Home'));
    expect(currentSite()).toBe('family');
  });
});

describe('a selection that has gone stale does not lock the install', () => {
  it('drops the selected space when it is the reason nobody is signed in', async () => {
    // Membership in the selected space was revoked. `/api/me` resolves the principal in
    // the SELECTED space, so it answers 401 — and the signed-out shell has no rail, so
    // there is no control on screen that can clear the selection that caused it.
    selectSite('family');
    window.history.replaceState(null, '', '/?site=family');

    render(<App />);
    await flush();
    await answerWith('/api/me', 401, { error: 'unauthorized' });

    // Retried without the selection, which is what recovers the session.
    await answer('/api/me', { principal: '01ADA' });
    await flush();
    expect(currentSite()).toBeNull();
    // …and the URL cannot put it back on the next reload.
    expect(window.location.search).not.toContain('site=');

    // The drive renders, which is the whole point: the rail is on screen and lists the
    // spaces this login really is in.
    await answer('/api/sites', [{ slug: 'home', name: 'Home', current: true }]);
    await answer('/folders/root/folders', []);
    await answer('/folders/root/files', []);
    expect(screen.getByRole('complementary')).toBeTruthy();
  });

  it('puts a URL-carried selection back when the retry fails too', async () => {
    // Storage is blocked, so `?site=` is the only place the selection lives — and the
    // recovery above deletes it before retrying. Restoring module memory alone restores
    // nothing here: signing in is a full navigation, and memory does not survive it, so
    // they would come back to the routed space instead of the one they chose.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    selectSite('family');
    window.history.replaceState(null, '', '/?site=family&keep=1#frag');

    render(<App />);
    await flush();
    await answerWith('/api/me', 401, { error: 'unauthorized' });
    await answerWith('/api/me', 401, { error: 'unauthorized' });

    expect(window.location.search).toContain('site=family');
    // The rest of the URL is not ours to rewrite.
    expect(window.location.search).toContain('keep=1');
    expect(window.location.hash).toBe('#frag');
  });

  it('keeps the selection when the 401 was simply nobody being signed in', async () => {
    selectSite('family');

    render(<App />);
    await flush();
    await answerWith('/api/me', 401, { error: 'unauthorized' });
    await answerWith('/api/me', 401, { error: 'unauthorized' });

    // Both answers were 401, so the space was never the problem. Forgetting the choice
    // here would land them in the routed space after signing in.
    expect(currentSite()).toBe('family');
    expect(screen.getByText(/Sign in to this space/)).toBeTruthy();
  });
});

describe('a write goes where the person is looking', () => {
  it('creates in My Drive rather than invisibly behind the trash', async () => {
    await renderDrive([{ id: '01F', parent_id: 'root', name: 'Papers', path: 'Papers' }], []);

    // Into a folder, then off to the trash. The folder id stays behind the trash view,
    // which is what made this a bug: the write used it, and the refresh afterwards
    // reloaded the trash — so it succeeded somewhere nobody could see.
    fireEvent.doubleClick(screen.getByText('Papers'));
    await flush();
    await answer('/folders/01F/folders', []);
    await answer('/folders/01F/files', []);

    fireEvent.click(rail().getByText('Trash'));
    await flush();
    await answer('/trash', []);

    newMenu();
    fireEvent.click(screen.getByText('New folder'));
    fireEvent.change(screen.getByLabelText('New folder'), { target: { value: 'Drafts' } });
    fireEvent.click(screen.getByText('Create'));

    // The root, because that is where the screen went — not 01F, the folder the trash
    // was hiding.
    const create = pending.find((p) => p.url.includes('/folders') && !p.url.includes('/trash'));
    expect(create?.url).toContain('/folders/root/folders');
  });
});

describe('the rail reports its own failures', () => {
  it('keeps saying the space list failed after a folder read succeeds', async () => {
    render(<DriveScreen {...shell} onError={() => {}} />);
    await flush();
    const sites = pending.findIndex((p) => p.url.includes('/api/sites'));
    await act(async () => {
      pending.splice(sites, 1)[0]!.reject(new Error('nope'));
    });

    // The drive's own refresh succeeds AFTER it, and it clears the shell's banner on
    // success — which used to erase this message whenever the order came out this way.
    await answer('/folders/root/folders', []);
    await answer('/folders/root/files', []);

    expect(screen.getByText(/Couldn’t list your spaces/)).toBeTruthy();
  });
});

describe('a space change survives storage that refuses to hold it', () => {
  it('clears a `?site=` link once the choice is stored, so it can be left', async () => {
    // Arrived through a link that names a space, with storage working. `api.ts` reads the
    // URL ahead of storage, so a parameter left behind outranks the new selection: every
    // click would persist correctly and none would take effect, pinning the person to the
    // linked space until they edited the address bar.
    selectSite('family');
    window.history.replaceState(null, '', '/?site=family');

    await renderDrive([], [], [
      { slug: 'home', name: 'Home', current: false },
      { slug: 'family', name: 'Family', current: true },
    ]);

    fireEvent.click(screen.getByText('Home'));
    expect(currentSite()).toBe('home');
    expect(window.location.search).not.toContain('site=');
  });

  it('carries the slug in the URL when it cannot be stored', async () => {
    // Private mode, blocked site data. The selection lives in module memory, and the
    // reload that applies it is exactly what throws that away — so without the URL,
    // clicking another space reloads back into the one you were in.
    // On `Storage.prototype`, not on `window.localStorage`: jsdom's storage is a Proxy,
    // so a spy installed as an own property of it is never consulted and the test would
    // pass against blocked storage it never blocked.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    window.history.replaceState(null, '', '/');

    await renderDrive([], [], [
      { slug: 'home', name: 'Home', current: true },
      { slug: 'family', name: 'Family', current: false },
    ]);

    fireEvent.click(screen.getByText('Family'));
    expect(window.location.search).toContain('site=family');
  });
});

describe('an invitation is redeemed by opening its link', () => {
  it('accepts the token, then resolves the session it just created', async () => {
    window.history.replaceState(null, '', '/?invite=tok-123');

    render(<App />);
    await flush();

    // The token leaves the URL before anything awaits: in the address bar it is one
    // screenshot or pasted link from being someone else's.
    expect(window.location.search).not.toContain('invite=');

    await answer('/api/accept-invite', { ok: true, principal: '01BJORN' });
    // Only NOW is there a principal to resolve — which is the ordering this boot exists
    // for. Asking first would have rendered the signed-out shell to someone holding a
    // valid invitation.
    await answer('/api/me', { principal: '01BJORN' });
    await flush();

    await answer('/api/sites', []);
    await answer('/folders/root/folders', []);
    await answer('/folders/root/files', []);
    expect(screen.getByRole('banner')).toBeTruthy();
  });

  it('sends an unauthenticated invitee to log in, with the token parked out of the URL', async () => {
    window.history.replaceState(null, '', '/?invite=tok-456');

    render(<App />);
    await flush();
    // Accepting binds whoever is signed in, so a 401 here means "no session yet" rather
    // than "bad token".
    await answerWith('/api/accept-invite', 401, { error: 'unauthorized' });

    // Parked in sessionStorage rather than carried through the login URL, so it appears in
    // no history entry or request log on the way to the issuer and back.
    expect(window.sessionStorage.getItem('canopy.drive.pending-invite')).toBe('tok-456');
    expect(window.location.search).not.toContain('invite=');
  });

  it('says what the server said when the invitation is spent', async () => {
    window.history.replaceState(null, '', '/?invite=tok-789');

    render(<App />);
    await flush();
    await answerWith('/api/accept-invite', 400, { detail: 'this invite is invalid or already used' });
    // The server's words, not ours: "already used" and "the network is down" are different
    // facts, and one sentence of our own would caption the second as the first.
    await answer('/api/me', { principal: '01ADA' });
    await flush();

    expect(screen.getByText(/already used/)).toBeTruthy();
    // And it does not retry on the next load.
    expect(window.sessionStorage.getItem('canopy.drive.pending-invite')).toBeNull();
  });
});

describe('the People surface is offered only to whoever may use it', () => {
  it('shows nothing in the menu for a member', async () => {
    await renderDrive();
    await answer('/people/access', { canManage: false });

    accountMenu();
    expect(screen.queryByText('People…')).toBeNull();
  });

  it('asks before removing somebody, and then removes them', async () => {
    await renderDrive();
    await answer('/people/access', { canManage: true });
    accountMenu();
    fireEvent.click(screen.getByText('People…'));
    await answer('/api/invites', { roles: ['member'], invites: [] });
    await answer('/api/people', {
      people: [{ principal: '01B', email: 'bjorn@example.com', name: 'Bjorn', seen_at: 'x' }],
    });

    // One click asks. Nothing is sent — removal takes the grants with it and re-inviting does
    // not bring them back, so it is not a thing to do on a mis-click.
    fireEvent.click(screen.getByRole('button', { name: /^Remove Bjorn/ }));
    expect(pending.filter((p) => p.url.includes('/api/people/01B'))).toHaveLength(0);
    expect(screen.getByText(/Removes their access/)).toBeTruthy();

    // The second click sends it, as a DELETE of the worker's own route — the one that does all
    // three parts. The module's `forget-person` has no route precisely so this cannot be half
    // done from a client.
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    const sent = pending.find((p) => p.url.includes('/api/people/01B'));
    expect(sent?.method).toBe('DELETE');

    await answer('/api/people/01B', { principal: '01B', revoked: 2, unbound: 1 });
    // And the list is re-read, so the row goes without a second look.
    expect(pending.some((p) => p.url.endsWith('/api/people'))).toBe(true);
  });

  it('can be talked out of it', async () => {
    await renderDrive();
    await answer('/people/access', { canManage: true });
    accountMenu();
    fireEvent.click(screen.getByText('People…'));
    await answer('/api/invites', { roles: ['member'], invites: [] });
    await answer('/api/people', {
      people: [{ principal: '01B', email: 'bjorn@example.com', name: 'Bjorn', seen_at: 'x' }],
    });

    fireEvent.click(screen.getByRole('button', { name: /^Remove Bjorn/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: /^Remove Bjorn/ })).toBeTruthy();
    expect(pending.filter((p) => p.url.includes('/api/people/01B'))).toHaveLength(0);
  });

  it('can still invite when the roster read fails', async () => {
    await renderDrive();
    await answer('/people/access', { canManage: true });

    accountMenu();
    fireEvent.click(screen.getByText('People…'));
    await answer('/api/invites', {
      roles: ['member'],
      invites: [{ principal: '01P', roleKey: 'member', email: 'bjorn@example.com' }],
    });
    // The lesser read fails. Awaiting the two together used to discard the invitation list
    // with it and leave `roles` empty — which disables Invite, so failing to read who has
    // signed in took away the one thing this dialog is for.
    const roster = pending.findIndex((p) => p.url.includes('/api/people'));
    await act(async () => {
      pending.splice(roster, 1)[0]!.reject(new Error('nope'));
    });

    // The invitation still renders — in the one list, marked as not yet arrived.
    expect(screen.getByText('bjorn@example.com')).toBeTruthy();
    expect(screen.getByText(/· invited/)).toBeTruthy();
    // The DOM property, not `toBeDisabled` — this suite has no jest-dom matchers.
    expect((screen.getByRole('button', { name: /Invite/ }) as HTMLButtonElement).disabled).toBe(false);
    // And the failure is reported BESIDE the list rather than in place of it, which is the
    // same mistake as bundling the reads, made in the rendering instead.
    expect(screen.getByText(/Couldn’t read who is in this space/)).toBeTruthy();
  });

  it('does not repopulate the list with a read from before it was closed', async () => {
    await renderDrive();
    await answer('/people/access', { canManage: true });

    accountMenu();
    fireEvent.click(screen.getByText('People…'));
    // The read is in flight and unanswered. The dialog is closed on top of it — this
    // component stays mounted, so nothing cancels it.
    fireEvent.keyDown(document, { key: 'Escape' });
    await answer('/api/invites', {
      roles: ['member'],
      invites: [{ principal: '01P', roleKey: 'member', email: 'ghost@example.com' }],
    });
    await answer('/api/people', { people: [] });

    // Reopened, its own read still pending: what shows now is whatever state the closed
    // dialog was left in. A stale answer applied while closed would be sitting here.
    accountMenu();
    fireEvent.click(screen.getByText('People…'));
    expect(screen.queryByText('ghost@example.com')).toBeNull();
    // Back to loading — the two reads share one ticket, so a stale answer cannot land half of
    // the list they are merged into.
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('offers it to an owner, and the dialog lists what is still waiting', async () => {
    await renderDrive();
    await answer('/people/access', { canManage: true });

    accountMenu();
    fireEvent.click(screen.getByText('People…'));
    await answer('/api/invites', {
      roles: ['member'],
      invites: [{ principal: '01P', roleKey: 'member', email: 'bjorn@example.com' }],
    });
    await answer('/api/people', {
      people: [
        { principal: '01ADA', email: 'ada@example.com', name: 'Ada', seen_at: '2026-09-29T00:00:00.000Z' },
        // Neither claim released: a principal and nothing else, which has to render as
        // itself rather than as an empty row.
        { principal: '01NAMELESS', email: null, name: null, seen_at: '2026-09-29T00:00:00.000Z' },
      ],
    });

    // One list: who is here, and who has been invited and not yet arrived.
    expect(screen.getByText('Ada')).toBeTruthy();
    expect(screen.getByText('01NAMELESS')).toBeTruthy();
    expect(screen.getByText('bjorn@example.com')).toBeTruthy();
    expect(screen.getByText(/· invited/)).toBeTruthy();
    // An invitation is withdrawn on ONE click — nobody has used it — where removing a person
    // takes two.
    expect(
      screen.getByRole('button', { name: /Withdraw the invitation for bjorn@example.com/ }),
    ).toBeTruthy();
  });
});

describe('sharing a folder', () => {
  /** Open the share dialog on the one folder in the listing, via the row menu. */
  async function openShare(): Promise<void> {
    await renderDrive([{ id: '01F', parent_id: 'root', name: 'Papers', path: 'Papers' }], []);
    await answer('/people/access', { canManage: true });
    // The row's own Radix menu, which answers the keyboard rather than `click`.
    const row = screen.getByText('Papers').closest('tr') ?? screen.getByText('Papers');
    fireEvent.keyDown(within(row as HTMLElement).getByRole('button'), { key: 'Enter' });
    fireEvent.click(screen.getByText('Share'));
  }

  it('lists who has access, with the level their keys add up to', async () => {
    await openShare();
    await answer('/folders/01F/shares', {
      shares: [
        // Two rows, one person: the keys are independent, and the dialog has to add them up
        // rather than render the same person twice at two levels.
        //
        // MANAGE FIRST, which is the order the server actually returns — its `ORDER BY`
        // sorts by permission, and 'drive:manage' sorts before 'drive:write'. With the rows
        // this way round, an aggregation that simply takes the last row seen downgrades
        // Bjorn to "can edit"; my first version of this test listed write first and would
        // have passed against exactly that bug.
        { folder_id: '01F', principal: '01B', permission: 'drive:manage', granted_at: 'x', granted_by: '01ADA', email: 'bjorn@example.com', name: 'Bjorn' },
        { folder_id: '01F', principal: '01B', permission: 'drive:write', granted_at: 'x', granted_by: '01ADA', email: 'bjorn@example.com', name: 'Bjorn' },
        { folder_id: '01F', principal: '01C', permission: 'drive:write', granted_at: 'x', granted_by: '01ADA', email: null, name: null },
      ],
    });
    await answer('/api/people', { people: [] });

    expect(screen.getAllByText('Bjorn')).toHaveLength(1);
    // The higher level wins for somebody holding both keys.
    expect((screen.getByLabelText('Access for Bjorn') as HTMLSelectElement).value).toBe('manage');
    // And an unseen person reads as their id rather than as a blank row.
    expect((screen.getByLabelText('Access for 01C') as HTMLSelectElement).value).toBe('edit');
  });

  it('shares at a level, which is one call per key it carries', async () => {
    await openShare();
    await answer('/folders/01F/shares', { shares: [] });
    await answer('/api/people', {
      people: [{ principal: '01B', email: 'bjorn@example.com', name: 'Bjorn', seen_at: 'x' }],
    });

    // The level first, then type a name and pick the suggestion — choosing somebody IS the
    // share, as it was in the portal's dialog.
    fireEvent.change(screen.getByLabelText('Access'), { target: { value: 'manage' } });
    fireEvent.change(screen.getByLabelText('Person'), { target: { value: 'bjor' } });
    fireEvent.click(screen.getByText('Bjorn'));

    // `write` FIRST: the keys are applied weakest-first, so a failure halfway leaves the
    // lesser access rather than the greater.
    const first = pending.find((p) => p.url.includes('/folders/01F/shares'));
    expect(first).toBeTruthy();
    await answer('/folders/01F/shares', { folder_id: '01F', principal: '01B', permission: 'drive:write' });
    await answer('/folders/01F/shares', { folder_id: '01F', principal: '01B', permission: 'drive:manage' });

    // Then it re-reads, which is how the row appears without a second click.
    expect(pending.some((p) => p.url.includes('/folders/01F/shares'))).toBe(true);
  });

  it('lowers a level by removing one key, never by removing both and re-granting', async () => {
    await openShare();
    await answer('/folders/01F/shares', {
      shares: [
        { folder_id: '01F', principal: '01B', permission: 'drive:manage', granted_at: 'x', granted_by: '01ADA', email: 'bjorn@example.com', name: 'Bjorn' },
        { folder_id: '01F', principal: '01B', permission: 'drive:write', granted_at: 'x', granted_by: '01ADA', email: 'bjorn@example.com', name: 'Bjorn' },
      ],
    });
    await answer('/api/people', { people: [] });

    fireEvent.change(screen.getByLabelText('Access for Bjorn'), { target: { value: 'edit' } });

    // The first call is a DELETE of the manage key either way — the calls are sequential, so
    // asserting here alone would pass against the version that removes both and re-grants,
    // which is what my first draft of this test did.
    const first = pending.filter((p) => p.url.includes('/folders/01F/shares') && p.method !== 'GET');
    expect(first).toHaveLength(1);
    expect(first[0]!.method).toBe('DELETE');
    expect(first[0]!.body).toContain('drive:manage');

    // So answer it and look at what FOLLOWS. Nothing should: taking both keys away and
    // granting write back is two operations whose second can fail — `ctx.grant` refuses a
    // sharer holding manage but not write — and then a downgrade has become a removal.
    await answer('/folders/01F/shares', {});
    const after = pending.filter((p) => p.url.includes('/folders/01F/shares') && p.method !== 'GET');
    expect(after).toHaveLength(0);
    // What does follow is the re-read, which is how the row shows its new level.
    expect(pending.some((p) => p.url.includes('/folders/01F/shares') && p.method === 'GET')).toBe(true);
  });

  it('drops a mutation that finishes after the dialog moved on', async () => {
    await openShare();
    await answer('/folders/01F/shares', {
      shares: [
        { folder_id: '01F', principal: '01B', permission: 'drive:write', granted_at: 'x', granted_by: '01ADA', email: null, name: null },
      ],
    });
    await answer('/api/people', { people: [] });

    fireEvent.click(screen.getByRole('button', { name: /Remove access for/ }));
    // The dialog is closed while the withdrawal is still in flight.
    fireEvent.keyDown(document, { key: 'Escape' });

    // Both keys are withdrawn by a removal; answer them after the close.
    await answer('/folders/01F/shares', {});
    await answer('/folders/01F/shares', {});

    // No re-read of 01F's shares: the action belonged to a folder nobody is looking at, and
    // its `load` would have taken a fresh ticket and so passed the staleness check — writing
    // 01F's access list under whatever folder is opened next.
    expect(pending.filter((p) => p.url.includes('/folders/01F/shares') && p.method === 'GET')).toHaveLength(0);
  });

  it('does not offer to share a folder with the person doing the sharing', async () => {
    await openShare();
    await answer('/folders/01F/shares', { shares: [] });
    await answer('/api/people', {
      people: [
        // `shell.auth.principal` is 01ADA — the caller. They hold the space already, so
        // offering it would be an action that does nothing.
        { principal: '01ADA', email: 'ada@example.com', name: 'Ada', seen_at: 'x' },
        { principal: '01B', email: 'bjorn@example.com', name: 'Bjorn', seen_at: 'x' },
      ],
    });

    // Both names contain an "a", so both would match a picker that offered everybody.
    fireEvent.change(screen.getByLabelText('Person'), { target: { value: 'a' } });
    expect(screen.getByText('Bjorn')).toBeTruthy();
    expect(screen.queryByText('Ada')).toBeNull();
  });

  it('suggests only matches, and leaves an unknown address to be invited', async () => {
    await openShare();
    await answer('/folders/01F/shares', { shares: [] });
    await answer('/api/people', {
      people: [{ principal: '01B', email: 'bjorn@example.com', name: 'Bjorn', seen_at: 'x' }],
    });

    // A name that matches nobody suggests nothing — and the field still submits, which is the
    // path to somebody who is not in the space yet. The portal reached them with an `email`
    // grant subject; here it is an invitation plus a grant on the pre-minted principal.
    fireEvent.change(screen.getByLabelText('Person'), { target: { value: 'nobody@example.com' } });
    expect(screen.queryByText('Bjorn')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    // Not yet: an invitation makes them a member of the WHOLE space, which reads everything,
    // and the dialog says so before doing it rather than after.
    expect(pending.some((p) => p.url.includes('/api/invites'))).toBe(false);
    expect(screen.getByText(/read everything in it/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Invite and share' }));

    const invite = pending.find((p) => p.url.includes('/api/invites'));
    expect(invite?.method).toBe('POST');
    expect(invite?.body).toContain('nobody@example.com');

    // Then the grant, to the principal the invitation minted.
    await answer('/api/invites', {
      principal: '01NEW',
      roleKey: 'member',
      email: 'nobody@example.com',
      acceptUrl: 'https://drive.example/?invite=tok',
    });
    const grant = pending.find((p) => p.url.includes('/folders/01F/shares') && p.method === 'POST');
    expect(grant?.body).toContain('01NEW');

    // And the link is shown once, because that link IS the invitation.
    await answer('/folders/01F/shares', { folder_id: '01F', principal: '01NEW', permission: 'drive:write' });
    expect(screen.getByDisplayValue('https://drive.example/?invite=tok')).toBeTruthy();
  });

  /** Type an unknown address, confirm, and let the invitation come back as 01NEW. */
  async function inviteNobody(): Promise<void> {
    await answer('/folders/01F/shares', { shares: [] });
    await answer('/api/people', { people: [] });
    fireEvent.change(screen.getByLabelText('Person'), { target: { value: 'nobody@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    fireEvent.click(screen.getByRole('button', { name: 'Invite and share' }));
    await answer('/api/invites', {
      principal: '01NEW',
      roleKey: 'member',
      email: 'nobody@example.com',
      acceptUrl: 'https://drive.example/?invite=tok',
    });
  }

  it('undoes the invitation when the share after it fails', async () => {
    await openShare();
    await inviteNobody();
    await answerWith('/folders/01F/shares', 500, { error: 'boom' });

    // The invitation goes FIRST — that alone makes the seat unreachable — and then the seat
    // is removed like a person, taking the member role and any key that did land. Left
    // standing, a retry would mint a second seat beside a live first one.
    const revoke = pending.find((p) => p.url.includes('/api/invites/01NEW/revoke'));
    expect(revoke?.method).toBe('POST');
    expect(pending.some((p) => p.url.includes('/people/01NEW'))).toBe(false);
    await answer('/api/invites/01NEW/revoke', null);

    const removal = pending.find((p) => p.url.includes('/people/01NEW'));
    expect(removal?.method).toBe('DELETE');
    await answer('/people/01NEW', { principal: '01NEW', revoked: 1, unbound: 0 });

    expect(screen.getByText(/was not invited/)).toBeTruthy();
    expect(screen.queryByDisplayValue('https://drive.example/?invite=tok')).toBeNull();
  });

  it('does not bring an invitation link back after the dialog moved on', async () => {
    await openShare();
    await inviteNobody();
    // Closed while the grant is still in flight.
    fireEvent.keyDown(document, { key: 'Escape' });
    await answer('/folders/01F/shares', { folder_id: '01F', principal: '01NEW', permission: 'drive:write' });

    // Reopened: the link belonged to the dialog that was closed, and a late answer must not
    // restore it onto whatever folder is open now.
    const row = screen.getByText('Papers').closest('tr') ?? screen.getByText('Papers');
    fireEvent.keyDown(within(row as HTMLElement).getByRole('button'), { key: 'Enter' });
    fireEvent.click(screen.getByText('Share'));
    expect(screen.queryByDisplayValue('https://drive.example/?invite=tok')).toBeNull();
  });

  it('exposes its suggestions as a combobox and the highlighted one as active', async () => {
    await openShare();
    await answer('/folders/01F/shares', { shares: [] });
    await answer('/api/people', {
      people: [
        { principal: '01B', email: 'bjorn@example.com', name: 'Bjorn', seen_at: 'x' },
        { principal: '01C', email: 'bea@example.com', name: 'Bea', seen_at: 'x' },
      ],
    });

    const field = screen.getByRole('combobox', { name: 'Person' });
    expect(field.getAttribute('aria-expanded')).toBe('false');
    fireEvent.change(field, { target: { value: 'b' } });

    expect(field.getAttribute('aria-expanded')).toBe('true');
    const listbox = screen.getByRole('listbox');
    expect(field.getAttribute('aria-controls')).toBe(listbox.id);
    const options = within(listbox).getAllByRole('option');
    expect(options).toHaveLength(2);

    // What Enter would pick is what the reader announces, and it follows the arrows.
    expect(field.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(field.getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');
  });

  it('keeps the highlight where the arrows put it when the dialog re-renders', async () => {
    await openShare();
    await answer('/folders/01F/shares', { shares: [] });
    await answer('/api/people', {
      people: [
        { principal: '01B', email: 'bjorn@example.com', name: 'Bjorn', seen_at: 'x' },
        { principal: '01C', email: 'bea@example.com', name: 'Bea', seen_at: 'x' },
      ],
    });

    const field = screen.getByRole('combobox', { name: 'Person' });
    fireEvent.change(field, { target: { value: 'b' } });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    const second = within(screen.getByRole('listbox')).getAllByRole('option')[1]!.id;

    // Any state change in the dialog re-renders it, and the list it passes is derived during
    // render — a new array with the same people. That must not count as a new list.
    fireEvent.change(screen.getByLabelText('Access'), { target: { value: 'manage' } });
    expect(field.getAttribute('aria-activedescendant')).toBe(second);
  });

  it('says it is you, not that you already have access, when you type your own address', async () => {
    await openShare();
    await answer('/folders/01F/shares', { shares: [] });
    await answer('/api/people', {
      people: [{ principal: '01ADA', email: 'ada@example.com', name: 'Ada', seen_at: 'x' }],
    });

    fireEvent.change(screen.getByLabelText('Person'), { target: { value: 'ada@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    expect(screen.getByText(/That is you/)).toBeTruthy();
    expect(screen.queryByText(/already has access to this folder/)).toBeNull();
    expect(pending.some((p) => p.method === 'POST')).toBe(false);
  });
});


describe('folder pages', () => {
  const folder = (id: string, name: string) => ({ id, name, parent_id: 'root', path: name });
  async function firstPage(onError = vi.fn()) {
    render(<DriveScreen {...shell} onError={onError} />);
    await flush();
    await answer('/api/sites', []);
    await answerWith('/folders/root/folders', 200, [folder('01A', 'Alpha')], { Link: `<${window.location.origin}/api/folders/root/folders?cursor=older>; rel="next"` });
    await answer('/folders/root/files', []);
  }

  it('appends more folders while retaining existing rows', async () => {
    await firstPage();
    fireEvent.click(screen.getByRole('button', { name: 'Load more folders' }));
    await answer('/folders/root/folders?cursor=older', [folder('01A', 'Alpha'), folder('01B', 'Beta')]);
    expect(screen.getAllByText('Alpha')).toHaveLength(1);
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more folders' })).toBeNull();
  });

  it('clears a failed folder page error after a successful retry', async () => {
    const onError = vi.fn();
    await firstPage(onError);
    fireEvent.click(screen.getByRole('button', { name: 'Load more folders' }));
    await answerWith('/folders/root/folders?cursor=older', 503, { detail: 'page failed' });
    expect(onError).toHaveBeenLastCalledWith('page failed');
    expect(screen.getByText('Alpha')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more folders' }));
    await answer('/folders/root/folders?cursor=older', [folder('01B', 'Beta')]);
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(onError).toHaveBeenLastCalledWith(null);
  });

  it('retires an older-folder page after entering a folder', async () => {
    await firstPage();
    fireEvent.click(screen.getByRole('button', { name: 'Load more folders' }));
    fireEvent.doubleClick(screen.getByText('Alpha'));
    await flush();
    await answer('/folders/01A/folders', []);
    await answer('/folders/01A/files', []);
    await answer('/folders/root/folders?cursor=older', [folder('01B', 'Beta')]);
    expect(screen.queryByText('Beta')).toBeNull();
  });

  it('loads additional destinations in the move picker', async () => {
    await renderDrive([], [file('01F', 'notes.md')]);
    fireEvent.contextMenu(screen.getByText('notes.md').closest('tr')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move' }));
    await answerWith('/folders/root/folders', 200, [folder('01A', 'Alpha')], { Link: `<${window.location.origin}/api/folders/root/folders?cursor=older>; rel="next"` });
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Load more folders' }));
    await answer('/folders/root/folders?cursor=older', [folder('01B', 'Beta')]);
    expect(within(dialog).getByRole('button', { name: 'Alpha' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Beta' })).toBeTruthy();
  });
});


describe('file pages', () => {
  async function firstPage() {
    const error = vi.fn();
    render(<DriveScreen {...shell} onError={error} />);
    await flush();
    await answer('/api/sites', []);
    await answer('/folders/root/folders', []);
    await answerWith('/folders/root/files', 200, [file('01A', 'first.txt')], { Link: `<${window.location.origin}/api/folders/root/files?cursor=older>; rel="next"` });
    return error;
  }

  it('preserves the first page on failure and appends distinct rows on retry', async () => {
    const error = await firstPage();
    fireEvent.click(screen.getByRole('button', { name: 'Load more files' }));
    await answerWith('/folders/root/files?cursor=older', 503, { detail: 'Page failed' });
    expect(error).toHaveBeenCalledWith('Page failed');
    expect(screen.getByText('first.txt')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more files' }));
    await answer('/folders/root/files?cursor=older', [file('01A', 'first.txt'), file('01B', 'second.txt')]);
    expect(screen.getAllByText('first.txt')).toHaveLength(1);
    expect(screen.getByText('second.txt')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more files' })).toBeNull();
  });

  it('discards a page from the drive after navigating to Trash', async () => {
    await firstPage();
    fireEvent.click(screen.getByRole('button', { name: 'Load more files' }));
    fireEvent.click(screen.getByRole('button', { name: 'Trash' }));
    await flush();
    await answer('/api/trash', []);
    await answer('/folders/root/files?cursor=older', [file('01B', 'second.txt')]);
    expect(screen.queryByText('second.txt')).toBeNull();
    expect(screen.getByText('Trash is empty')).toBeTruthy();
  });
});


describe('Trash pages', () => {
  it('continues through an empty filtered page and lets an older file be restored', async () => {
    await renderDrive();
    fireEvent.click(screen.getByRole('button', { name: 'Trash' }));
    await flush();
    await answerWith('/api/trash', 200, [], { Link: `<${window.location.origin}/api/trash?cursor=older>; rel="next"` });
    expect(screen.queryByText('Trash is empty')).toBeNull();
    expect(screen.getByText('No files on this page')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more Trash' }));
    await answer('/api/trash?cursor=older', [file('01A', 'old.txt')]);
    fireEvent.contextMenu(screen.getByText('old.txt').closest('tr')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restore' }));
    await answer('/files/01A/restore', file('01A', 'old.txt'));
    await answer('/api/trash', []);
    expect(screen.getByText('Trash is empty')).toBeTruthy();
  });

  it('retains loaded Trash rows on a failed page and allows retry', async () => {
    await renderDrive();
    fireEvent.click(screen.getByRole('button', { name: 'Trash' }));
    await flush();
    await answerWith('/api/trash', 200, [file('01A', 'first.txt')], { Link: `<${window.location.origin}/api/trash?cursor=older>; rel="next"` });
    fireEvent.click(screen.getByRole('button', { name: 'Load more Trash' }));
    await answerWith('/api/trash?cursor=older', 503, { detail: 'retry' });
    expect(screen.getByText('first.txt')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more Trash' }));
    await answer('/api/trash?cursor=older', [file('01B', 'second.txt')]);
    expect(screen.getByText('second.txt')).toBeTruthy();
    expect(screen.getByText('first.txt')).toBeTruthy();
  });
});


it('restores saved layout and ordering, and persists a layout change', async () => {
  localStorage.setItem('canopy.drive.view', JSON.stringify({ version: 1, layout: 'grid', sort: { key: 'name', dir: 'desc' } }));
  await renderDrive([], [file('a', 'alpha.txt'), file('z', 'zeta.txt')]);
  expect(screen.getByRole('button', { name: 'Switch to list' })).toBeTruthy();
  const names = screen.getAllByText(/^(alpha|zeta)\.txt$/);
  expect(names.map(node => node.textContent)).toEqual(['zeta.txt', 'alpha.txt']);
  fireEvent.click(screen.getByRole('button', { name: 'Switch to list' }));
  expect(JSON.parse(localStorage.getItem('canopy.drive.view')!).layout).toBe('list');
});
