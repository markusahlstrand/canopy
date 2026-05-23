import type { CacheStore } from "@canopy/core";

/**
 * A {@link CacheStore} backed by the Cloudflare Cache API (`caches.default`).
 * Edge-local (per-colo) and free; TTL is carried by the stored response's
 * `Cache-Control: max-age`, which the Cache API honors on `match`. Keys are
 * encoded into a synthetic request URL. Cloudflare-only — the Node server uses
 * the SQL backend instead.
 */
interface CfCache {
  match(request: Request | string): Promise<Response | undefined>;
  put(request: Request | string, response: Response): Promise<void>;
}

// Access `caches.default` without redeclaring the global `caches` (lib.dom types it as CacheStorage).
const edgeCache = (): CfCache => (globalThis as unknown as { caches: { default: CfCache } }).caches.default;

export function createCacheApiCacheStore(opts: { origin?: string } = {}): CacheStore {
  const origin = opts.origin ?? "https://cache.canopy.internal/";
  const reqFor = (key: string) => new Request(origin + encodeURIComponent(key));

  const store: CacheStore = {
    async get<T>(key: string): Promise<T | null> {
      const res = await edgeCache().match(reqFor(key));
      if (!res) return null;
      try {
        return (await res.json()) as T;
      } catch {
        return null;
      }
    },
    async set(key: string, value: unknown, ttlMs: number): Promise<void> {
      const res = new Response(JSON.stringify(value), {
        headers: {
          "content-type": "application/json",
          "cache-control": `max-age=${Math.max(1, Math.ceil(ttlMs / 1000))}`,
        },
      });
      await edgeCache().put(reqFor(key), res);
    },
    async wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
      const hit = await store.get<T>(key);
      if (hit !== null) return hit;
      const fresh = await fn();
      await store.set(key, fresh, ttlMs);
      return fresh;
    },
  };
  return store;
}
