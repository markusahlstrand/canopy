import type { ConnectorResponse, FetchLike } from '@substrat-run/kernel';

/**
 * The only fetch the places reporter is allowed to make.
 *
 * `placesReporter` learns where to send a report from the issuer's own discovery
 * document (`/.well-known/substrat-places`) and POSTs the install's `client_secret`
 * to whatever URL it finds there. In vertical-auth 0.15.0 that URL is taken as given:
 * `placesDiscovery` is `z.string().url()`, so any scheme and any host is accepted,
 * and the POST runs with fetch's default `redirect: 'follow'`.
 *
 * The secret is the one that issuer itself issued, so an outright hostile issuer
 * learns nothing new here. What this closes is the case where an otherwise-honest
 * issuer's discovery document names somewhere ELSE — through a compromise, a
 * misconfiguration, or a redirect — and the secret leaves with it.
 *
 * Three rules, and each fails CLOSED: the reporter catches the throw and records
 * `outcome: 'failed'`, so a refused report is a report not sent, never a broken
 * request path.
 *
 *  1. **Same origin as the issuer.** Discovery is issuer + a fixed path, so it
 *     passes by construction; the report endpoint has to earn it.
 *  2. **HTTPS**, except on loopback, where a dev issuer legitimately runs on http.
 *  3. **`redirect: 'error'`.** A 30x to another host would otherwise carry the
 *     secret there — the same leak by a slower route.
 *
 * This belongs upstream, where one fix would cover every vertical; a guard in one
 * consumer protects only that consumer. Filed as substrat-run/substrat#1771 —
 * DELETE this when vertical-auth enforces it.
 */
export const isLoopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

type RuntimeFetch = (url: string, init: RequestInit) => Promise<unknown>;

export function placesFetch(
  issuer: string,
  /** Injectable for the tests; the runtime's own `fetch` everywhere else. */
  runtimeFetch: RuntimeFetch = (url, init) => fetch(url, init),
): FetchLike {
  const issuerOrigin = URL.canParse(issuer) ? new URL(issuer).origin : null;
  return async (input, init) => {
    if (!issuerOrigin) throw new Error('places: the configured issuer is not a URL');
    const url = new URL(input);
    if (url.origin !== issuerOrigin) {
      throw new Error(`places: refusing ${url.origin} — not the issuer's origin`);
    }
    if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
      throw new Error(`places: refusing ${url.protocol}// — the report carries a client secret`);
    }
    const res = await runtimeFetch(url.toString(), { ...(init as RequestInit), redirect: 'error' });
    return res as ConnectorResponse;
  };
}
