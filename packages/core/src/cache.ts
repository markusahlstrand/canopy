/**
 * A minimal TTL cache, implemented by swappable backends:
 *   - SQLite / D1 (the `kv_cache` table) — portable, the default everywhere;
 *   - Cloudflare Cache API (`caches.default`) — edge-local, free, fast.
 *
 * The host picks a backend per environment; call sites (and plugins) only see
 * this interface. Values are arbitrary JSON-serializable data.
 */
export interface CacheStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
  /** Return the cached value, or compute + store + return it. */
  wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T>;
}

/**
 * Wrap a CacheStore so every key is transparently prefixed. Used to isolate one
 * plugin's (or one user's) cache namespace from another's — critical once a cache
 * holds per-user data (e.g. private-repo issues) so it can't leak across tenants.
 */
export function scopedCache(base: CacheStore, prefix: string): CacheStore {
  const k = (key: string) => `${prefix}:${key}`;
  return {
    get: (key) => base.get(k(key)),
    set: (key, value, ttlMs) => base.set(k(key), value, ttlMs),
    wrap: (key, ttlMs, fn) => base.wrap(k(key), ttlMs, fn),
  };
}
