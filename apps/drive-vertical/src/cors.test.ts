/**
 * The CORS rule, which is the one setting that lets another site read this drive with
 * the visitor's session. Every case but the first two is a refusal.
 */
import { describe, expect, it } from 'vitest';
import { allowedOrigin } from './cors.js';

const PORTAL = 'https://app.ahlstrand.es';

describe('allowedOrigin', () => {
  it('admits exactly the configured origin', () => {
    expect(allowedOrigin(PORTAL, PORTAL)).toBe(PORTAL);
  });

  it('tolerates a trailing slash in the setting, which is what people paste', () => {
    expect(allowedOrigin(PORTAL, `${PORTAL}/`)).toBe(PORTAL);
  });

  it('says nothing when nothing is configured — the default', () => {
    expect(allowedOrigin(PORTAL, undefined)).toBeNull();
    expect(allowedOrigin(PORTAL, '')).toBeNull();
    expect(allowedOrigin(PORTAL, '   ')).toBeNull();
  });

  it('refuses a different scheme, host or port', () => {
    expect(allowedOrigin('http://app.ahlstrand.es', PORTAL)).toBeNull();
    expect(allowedOrigin('https://evil.example', PORTAL)).toBeNull();
    // A sibling host under the same domain is still another origin.
    expect(allowedOrigin('https://canopy.ahlstrand.es', PORTAL)).toBeNull();
    expect(allowedOrigin('https://app.ahlstrand.es:8443', PORTAL)).toBeNull();
    // The prefix trick: a host that merely starts with the allowed one.
    expect(allowedOrigin('https://app.ahlstrand.es.evil.test', PORTAL)).toBeNull();
  });

  it('never echoes a wildcard, however it is configured', () => {
    expect(allowedOrigin(PORTAL, '*')).toBeNull();
    expect(allowedOrigin('*', PORTAL)).toBeNull();
  });

  it('ignores a path in the setting rather than letting it widen the match', () => {
    expect(allowedOrigin(PORTAL, `${PORTAL}/drive`)).toBe(PORTAL);
  });

  it('says nothing when the request carries no origin', () => {
    expect(allowedOrigin(undefined, PORTAL)).toBeNull();
  });
});
