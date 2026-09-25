/**
 * Who, if anyone, may read this drive from another origin.
 *
 * Kept apart from `worker.ts` so it can be tested at all — the worker imports Durable
 * Objects and cannot load outside workerd. The rule is small and the consequence is
 * not: a credentialed CORS grant lets another site read this drive as whoever is
 * visiting it, so it matches ONE configured origin exactly and answers nothing
 * otherwise.
 */

/**
 * The origin to echo back, or null for "say nothing" — which is how CORS refuses.
 *
 * A wildcard is never returned: the browser rejects `*` on a credentialed request,
 * and it would be the wrong answer even where it worked. A configured value is
 * compared as an ORIGIN — scheme, host and port — so `https://app.example.com` does
 * not admit `http://app.example.com`, a different port, or a sibling host.
 */
export function allowedOrigin(
  requestOrigin: string | undefined,
  configured: string | undefined,
): string | null {
  if (!requestOrigin || !configured) return null;
  // A trailing slash is what someone pastes from a browser bar; it is not part of an
  // origin, and refusing the whole setting over it would be a puzzle, not a guard.
  const want = configured.trim().replace(/\/+$/, '');
  if (!want) return null;
  // Parsed rather than string-compared, so `https://app.example.com:443` and
  // `https://app.example.com` are the same origin and a path in the setting cannot
  // widen it.
  if (!URL.canParse(want) || !URL.canParse(requestOrigin)) return null;
  return new URL(want).origin === new URL(requestOrigin).origin ? new URL(requestOrigin).origin : null;
}
