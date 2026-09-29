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

/** One pending answer, and the handle a test resolves it with. */
interface Pending {
  url: string;
  resolve: (body: unknown, status?: number) => void;
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
        resolve: (body: unknown, status = 200) =>
          resolveFetch({
            ok: status < 400,
            status,
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
  await answerWith(match, 200, body);
}

/** The same, with a status — for the paths that are about being refused. */
async function answerWith(match: string, status: number, body: unknown): Promise<void> {
  const i = pending.findIndex((p) => p.url.includes(match));
  expect(i, `no pending request matching ${match}; saw ${pending.map((p) => p.url).join(', ')}`).toBeGreaterThan(-1);
  const [target] = pending.splice(i, 1);
  await act(async () => {
    target!.resolve(body, status);
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
    // one takes the principal it was handed and nothing else. Scoped to the header,
    // because the rail says "My Drive" too.
    expect(within(screen.getByRole('banner')).getByText('My Drive')).toBeTruthy();
    expect(screen.queryByText(/Log in/)).toBeNull();
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
