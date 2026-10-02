/**
 * The two things about this screen that are contracts rather than rendering.
 *
 * There is no DOM harness in this app (no jsdom, no testing-library), and adding one to
 * assert that a list renders rows would be a lot of setup for a weak claim. These are
 * the parts that break silently instead: a space selection that does not reach the
 * worker, and an icon name the icon set does not know.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasIcon } from '@canopy/ui';
import { DRIVE_ICONS } from './drive';
import { SIDEBAR_ICONS } from './sidebar';
import { actionsFor } from './file-table';
import { latestOnly } from './reads';
import {
  ApiError,
  TEXT_PREVIEW_LIMIT,
  contentUrl,
  fileVersionsPage,
  versionContentUrl,
  currentSite,
  fileBodyAsText,
  search,
  selectSite,
  siteHeaders,
} from './api';

afterEach(() => {
  selectSite(null);
  vi.unstubAllGlobals();
});

/** One stubbed answer, and the request it was asked for. */
function stubFetch(answer: { ok: boolean; status?: number; body?: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: answer.ok,
      status: answer.status ?? (answer.ok ? 200 : 400),
      statusText: 'stubbed',
      json: () => Promise.resolve(answer.body ?? {}),
    } as Response);
  });
  return calls;
}

describe('the space selection reaches the worker both ways it can', () => {
  it('rides as x-site on ordinary calls', () => {
    selectSite('family');
    expect(siteHeaders()).toMatchObject({ 'x-site': 'family' });
    expect(currentSite()).toBe('family');
  });

  it('rides as ?site= on a download, because a link cannot set a header', () => {
    selectSite('family');
    // The worker reads `x-site` first and falls back to this, so the two spellings are
    // one selection. A download is a plain link the browser follows; buffering the file
    // through the app just to send a header would defeat streaming it.
    expect(contentUrl('01ABC')).toBe('/api/files/01ABC/content?site=family');
  });

  it('names no space when none is selected — the hostname already chose', () => {
    expect(siteHeaders()).toEqual({});
    expect(contentUrl('01ABC')).toBe('/api/files/01ABC/content');
    expect(versionContentUrl('01ABC', '01V')).toBe('/api/files/01ABC/versions/01V/content');
  });

  it('escapes what it puts in the URL', () => {
    selectSite('a/b?c');
    expect(contentUrl('x y')).toBe('/api/files/x%20y/content?site=a%2Fb%3Fc');
    expect(versionContentUrl('x y', 'v/z?')).toBe('/api/files/x%20y/versions/v%2Fz%3F/content?site=a%2Fb%3Fc');
  });
});

describe('every icon the screen asks for exists', () => {
  it('resolves each name, so none of them renders the silent fallback', () => {
    // `Icon` answers an unknown name with a puzzle piece rather than throwing. That is
    // right for a plugin naming something we do not ship, and wrong here: a typo would
    // ship as a puzzle piece in a toolbar. Three of these were wrong when written.
    for (const name of [...DRIVE_ICONS, ...SIDEBAR_ICONS]) expect(hasIcon(name), name).toBe(true);
  });
});

describe('search asks the one question the API declares', () => {
  it('encodes the term and carries the space selection', async () => {
    selectSite('family');
    const calls = stubFetch({ ok: true, body: { hits: [] } });

    await search('lease & rent', 10);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/search?term=lease%20%26%20rent&limit=10');
    expect(calls[0]!.init?.headers).toMatchObject({ 'x-site': 'family' });
  });

  it('omits the limit when the caller has no opinion', async () => {
    const calls = stubFetch({ ok: true, body: { hits: [] } });
    await search('lease');
    expect(calls[0]!.url).toBe('/api/search?term=lease');
  });

  it('surfaces a refusal as ApiError, with the problem detail', async () => {
    stubFetch({ ok: false, status: 400, body: { detail: 'term is too short' } });
    // The screen holds its request below the floor; this is what happens if it does not,
    // and the message has to be the platform's rather than a status line.
    await expect(search('a')).rejects.toBeInstanceOf(ApiError);
    await expect(search('a')).rejects.toThrow('term is too short');
  });
});

describe('only the newest read may write to the screen', () => {
  it('invalidates every earlier ticket', () => {
    const reads = latestOnly();
    const first = reads.take();
    expect(reads.current(first)).toBe(true);

    const second = reads.take();
    // The race this exists for: `first` is a request already in flight when the term
    // changed. Debouncing cancelled no such request — only the pending timer — so it
    // will answer, and it must not be allowed to render.
    expect(reads.current(first)).toBe(false);
    expect(reads.current(second)).toBe(true);
  });

  it('stays false for a ticket that lost, however late it answers', () => {
    const reads = latestOnly();
    const stale = reads.take();
    reads.take();
    reads.take();
    expect(reads.current(stale)).toBe(false);
  });

  it('invalidates in flight reads the moment the context changes', () => {
    const reads = latestOnly();
    const inFlight = reads.take();
    expect(reads.current(inFlight)).toBe(true);

    // The window taking a ticket per READ left open: the search box is debounced, so
    // between a keystroke and the request it schedules, the PREVIOUS term's request
    // still held the current ticket — and answering inside that window wrote hits for a
    // term the box no longer held, below the minimum length, clearing `busy` on the way.
    reads.invalidate();
    expect(reads.current(inFlight)).toBe(false);

    // And it claims nothing: the next read takes its own ticket rather than inheriting.
    const next = reads.take();
    expect(reads.current(next)).toBe(true);
  });
});

describe('a text preview stops reading at the limit', () => {
  /** A body delivered in chunks, so the reader can be observed stopping. */
  function streamOf(chunks: string[]): { body: ReadableStream<Uint8Array>; pulled: () => number; cancelled: () => boolean } {
    let pulled = 0;
    let cancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= chunks.length) return controller.close();
        controller.enqueue(encoder.encode(chunks[pulled]!));
        pulled += 1;
      },
      cancel() {
        cancelled = true;
      },
    });
    return { body, pulled: () => pulled, cancelled: () => cancelled };
  }

  it('cancels the response instead of downloading the rest', async () => {
    // Ten chunks of 100k: `res.text()` would decode all 1M characters to show 200k. The
    // point of the bound is that the rest never crosses the wire.
    const stream = streamOf(Array.from({ length: 10 }, () => 'x'.repeat(100_000)));
    vi.stubGlobal('fetch', () =>
      Promise.resolve({ ok: true, status: 200, statusText: 'ok', body: stream.body } as Response),
    );

    const got = await fileBodyAsText('01A');

    expect(got.truncated).toBe(true);
    expect(got.text).toHaveLength(TEXT_PREVIEW_LIMIT);
    expect(stream.cancelled()).toBe(true);
    // Two chunks is 200k — enough to fill the bound. The other eight are never asked for.
    expect(stream.pulled()).toBeLessThanOrEqual(3);
  });

  it('keeps a short body whole, and says it was not cut', async () => {
    const stream = streamOf(['short enough']);
    vi.stubGlobal('fetch', () =>
      Promise.resolve({ ok: true, status: 200, statusText: 'ok', body: stream.body } as Response),
    );
    await expect(fileBodyAsText('01A')).resolves.toEqual({ text: 'short enough', truncated: false });
  });
});

describe('the table offers only what the screen can perform', () => {
  it('gives a folder no download and no delete, and Share only now that it exists', () => {
    // Download and Delete were in the moved component's menus for every row. A folder cannot
    // be downloaded — there is no archive endpoint — and `trash-file` takes a file.
    //
    // Share is here as of #79, and only for a folder: a grant narrows onto a folder and
    // reaches what is under it through the declared parent edge, so there is no operation
    // that shares one file.
    expect(actionsFor({ id: '01F', name: 'Papers', kind: 'folder', modified: '—', size: '—', isFolder: true })).toEqual([
      'Open',
      'Share',
      'Rename',
      'Move',
    ]);
  });

  it('gives a file the five that have operations behind them', () => {
    expect(actionsFor({ id: '01A', name: 'a.md', kind: 'note', modified: 'today', size: '1 kB', isFolder: false })).toEqual([
      'Open',
      'Download',
      'Rename',
      'Move',
      'Delete',
    ]);
  });

  it('still offers no Reprocess, and no Share on a FILE', () => {
    // Reprocess came across with the component and has no operation behind it to this day.
    // Share earned its place; it stays off files, because sharing one is not a thing the
    // drive can do — the grant narrows onto a folder.
    const file = actionsFor({ id: '01A', name: 'a', kind: 'doc', modified: '—', size: '—', isFolder: false });
    const folder = actionsFor({ id: '01F', name: 'f', kind: 'folder', modified: '—', size: '—', isFolder: true });
    expect(file).not.toContain('Share');
    expect([...file, ...folder]).not.toContain('Reprocess');
  });
});


describe('history page continuations', () => {
  it('follows the next link with its page size and space header', async () => {
    selectSite('family');
    const origin = window.location.origin;
    const fetch = vi.fn().mockResolvedValueOnce(new Response('[]', { headers: { Link: `<${origin}/api/files/01A/versions?cursor=v%2F1&limit=10>; rel="next"` } }))
      .mockResolvedValueOnce(new Response('[]'));
    vi.stubGlobal('fetch', fetch);
    const first = await fileVersionsPage('01A');
    expect(first.next).not.toBeNull();
    const last = await fileVersionsPage('01A', first.next);
    expect(fetch).toHaveBeenLastCalledWith('/api/files/01A/versions?cursor=v%2F1&limit=10', expect.objectContaining({ credentials: 'same-origin', headers: { 'x-site': 'family' } }));
    expect(last.next).toBeNull();
  });

  it('refuses continuations outside the selected file and origin', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const next of ['https://other.example/api/files/01A/versions?cursor=x', `${window.location.origin}/api/files/other/versions?cursor=x`]) {
      await expect(fileVersionsPage('01A', next)).rejects.toThrow('Invalid version-history continuation');
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
