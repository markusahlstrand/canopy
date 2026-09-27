/**
 * The two things about this screen that are contracts rather than rendering.
 *
 * There is no DOM harness in this app (no jsdom, no testing-library), and adding one to
 * assert that a list renders rows would be a lot of setup for a weak claim. These are
 * the parts that break silently instead: a space selection that does not reach the
 * worker, and an icon name the icon set does not know.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { hasIcon } from '@canopy/ui';
import { DRIVE_ICONS } from './drive';
import { contentUrl, currentSite, selectSite, siteHeaders } from './api';

afterEach(() => selectSite(null));

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
