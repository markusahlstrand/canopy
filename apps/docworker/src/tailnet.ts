import { fetch as undiciFetch, ProxyAgent } from "undici";

/**
 * Resolve the tailnet egress proxy from the environment, in precedence order.
 * Shared by {@link createTailnetFetch} and {@link ensureTailnetReady} so they
 * agree on which proxy (if any) is in play — otherwise readiness could no-op
 * while requests still route through a proxy set via `ALL_PROXY`/`HTTPS_PROXY`.
 */
function getTailnetProxy(): string | undefined {
  return process.env.TAILNET_PROXY_URL || process.env.ALL_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy;
}

/**
 * A `fetch` that egresses over the tailnet, used to reach a Synology NAS that is
 * only reachable on the tailnet.
 *
 * Two ways the host becomes a tailnet peer, both transparent to callers:
 *   • In the container: a `tsnet` Go sidecar joins the tailnet and exposes a
 *     local HTTP CONNECT proxy; set `TAILNET_PROXY_URL=http://127.0.0.1:1055`
 *     and every request tunnels through it.
 *   • Local dev: the machine itself runs Tailscale, so no proxy is needed and we
 *     fall back to the platform `fetch` (the OS routes tailnet addresses).
 *
 * This is exactly why tailnet access lives in this service and not in the
 * Worker: a Worker isolate can't run the Tailscale data plane; a real process
 * (here, or your laptop) can.
 */
export function createTailnetFetch(): typeof fetch {
  const proxy = getTailnetProxy();
  if (!proxy) return fetch; // host is already on the tailnet (local dev)
  const dispatcher = new ProxyAgent(proxy);
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    })) as unknown as typeof fetch;
}

/**
 * Block until the tailnet sidecar is reachable, so the first request after a
 * cold start doesn't race the Tailscale handshake. The Go proxy only starts
 * listening *after* `tailscale up` succeeds, so a TCP-level response on its port
 * (even a 405 to our GET) means the tailnet is joined. A no-op in local dev,
 * where there's no proxy and the host is already on the tailnet.
 */
export async function ensureTailnetReady(timeoutMs = 25_000): Promise<void> {
  const proxy = getTailnetProxy();
  if (!proxy) return;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Bound each probe (capped at 5s, never past the deadline) so a stuck
    // connection can't hang a single attempt forever and outlast the timeout.
    const perAttempt = Math.max(0, Math.min(deadline - Date.now(), 5_000));
    try {
      await fetch(proxy, { method: "GET", signal: AbortSignal.timeout(perAttempt) }); // any HTTP response ⇒ listening ⇒ tailnet up
      return;
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`tailnet sidecar not ready after ${timeoutMs}ms: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
