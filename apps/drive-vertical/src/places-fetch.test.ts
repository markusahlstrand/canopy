/**
 * The guard in front of the places reporter, which is the one call in this vertical
 * that sends the install's `client_secret` somewhere the ISSUER chose.
 *
 * Every case here is a refusal except the two that should pass. The reporter itself
 * swallows the throw and records `outcome: 'failed'`, so what these assert is that a
 * refusal happens at all — by the time the secret is on the wire it is too late.
 */
import { describe, expect, it } from 'vitest';
import { placesFetch } from './places-fetch.js';

const ISSUER = 'https://auth.example.com';

/** A stub that records what reached the wire — which is the thing under test. */
function recorder() {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200 };
    },
  };
}

describe('placesFetch', () => {
  it('allows the issuer’s own origin, and forbids following redirects', async () => {
    const r = recorder();
    await placesFetch(ISSUER, r.fetch)(`${ISSUER}/.well-known/substrat-places`, { method: 'GET' });

    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.url).toBe(`${ISSUER}/.well-known/substrat-places`);
    // The rule that matters most: a 30x must not carry the secret to another host.
    expect(r.calls[0]!.init.redirect).toBe('error');
    expect(r.calls[0]!.init.method).toBe('GET');
  });

  it('refuses an endpoint on another origin', async () => {
    const r = recorder();
    // What a compromised or misconfigured discovery document would name.
    await expect(placesFetch(ISSUER, r.fetch)('https://collector.evil.test/report')).rejects.toThrow(
      /not the issuer's origin/,
    );
    expect(r.calls).toHaveLength(0);
  });

  it('refuses a sibling host on the issuer’s domain', async () => {
    const r = recorder();
    // Same registrable domain, different origin — still not the issuer.
    await expect(placesFetch(ISSUER, r.fetch)('https://logs.example.com/report')).rejects.toThrow(
      /not the issuer's origin/,
    );
    expect(r.calls).toHaveLength(0);
  });

  it('refuses cleartext for a non-loopback issuer', async () => {
    const r = recorder();
    await expect(placesFetch('http://auth.example.com', r.fetch)('http://auth.example.com/report')).rejects.toThrow(
      /client secret/,
    );
    expect(r.calls).toHaveLength(0);
  });

  it('allows http on loopback, where a dev issuer lives', async () => {
    const r = recorder();
    await placesFetch('http://localhost:8787', r.fetch)('http://localhost:8787/api/places/report', {
      method: 'POST',
    });
    expect(r.calls).toHaveLength(1);
  });

  it('refuses everything when the configured issuer is not a URL', async () => {
    const r = recorder();
    await expect(placesFetch('not-a-url', r.fetch)('https://auth.example.com/report')).rejects.toThrow(
      /not a URL/,
    );
    expect(r.calls).toHaveLength(0);
  });
});
