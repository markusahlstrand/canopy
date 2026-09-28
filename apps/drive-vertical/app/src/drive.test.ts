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
import { latestOnly } from './reads';
import { ApiError, contentUrl, currentSite, search, selectSite, siteHeaders } from './api';

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
  });

  it('escapes what it puts in the URL', () => {
    selectSite('a/b?c');
    expect(contentUrl('x y')).toBe('/api/files/x%20y/content?site=a%2Fb%3Fc');
  });
});

describe('every icon the screen asks for exists', () => {
  it('resolves each name, so none of them renders the silent fallback', () => {
    // `Icon` answers an unknown name with a puzzle piece rather than throwing. That is
    // right for a plugin naming something we do not ship, and wrong here: a typo would
    // ship as a puzzle piece in a toolbar. Three of these were wrong when written.
    for (const name of DRIVE_ICONS) expect(hasIcon(name), name).toBe(true);
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
