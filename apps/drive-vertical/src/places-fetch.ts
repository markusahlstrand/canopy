import { globalFetch } from '@substrat-run/kernel';
import type { ConnectorRequestInit, ConnectorResponse, FetchLike } from '@substrat-run/kernel';

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

/**
 * `globalFetch`, never the bare global. Boundary-lint's R3 refuses a call to the global
 * in a vertical's own source — capabilities come from the platform, not from the global
 * — and the kernel's wrapper is where that cast is sanctioned once. It forwards `init`
 * verbatim, so `redirect` still reaches the runtime even though `ConnectorRequestInit`
 * does not name it; that gap is in the upstream issue.
 *
 * R3 matches the source TEXT, comments included, so naming the banned call here — even
 * in prose, even to say we are not making it — trips the rule. Hence the circumlocution.
 */
const viaKernel: RuntimeFetch = (url, init) =>
  globalFetch(url, init as unknown as ConnectorRequestInit);

export function placesFetch(
  issuer: string,
  /** Injectable for the tests; the kernel's bound fetch everywhere else. */
  runtimeFetch: RuntimeFetch = viaKernel,
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
