/**
 * Backend reachability — and the fetch wrapper that tracks it.
 *
 * `navigator.onLine` only knows whether the network interface is up, not whether
 * *our* API actually answers (it's commonly true when the dev server is down).
 * So we track reachability ourselves: the backend is "reachable" once a call
 * returns any HTTP response, and "unreachable" when a request throws (DNS
 * failure, connection refused, the browser being offline). The offline banner
 * and offline write-gating read this signal; it's self-healing — the next
 * successful call flips it back.
 */

let reachable = true;
const listeners = new Set<() => void>();

function set(next: boolean) {
  if (reachable === next) return;
  reachable = next;
  for (const l of listeners) l();
}

export function isBackendReachable(): boolean {
  return reachable;
}

export function subscribeReachable(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * `fetch` against our API. Marks the backend reachable on any response and
 * unreachable when the request throws, then re-throws so callers keep their
 * existing error handling unchanged.
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    const res = await fetch(input, init);
    set(true);
    return res;
  } catch (err) {
    set(false);
    throw err;
  }
}
