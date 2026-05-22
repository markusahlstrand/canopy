import type { Db } from "./db";

/**
 * Tiny TTL cache over the `kv_cache` table (migration v6). Used to memoize
 * external API responses (e.g. GitHub issues/releases) across requests so the
 * data endpoints don't hammer a rate-limited upstream. Values are JSON.
 */
export function createCache(db: Db) {
  return {
    async get<T>(key: string): Promise<T | null> {
      const row = await db.first<{ v: string; expires_at: number }>(
        "SELECT v, expires_at FROM kv_cache WHERE k = ?",
        [key],
      );
      if (!row) return null;
      if (row.expires_at <= Date.now()) {
        await db.run("DELETE FROM kv_cache WHERE k = ?", [key]);
        return null;
      }
      try {
        return JSON.parse(row.v) as T;
      } catch {
        return null;
      }
    },

    async set(key: string, value: unknown, ttlMs: number): Promise<void> {
      const expires = Date.now() + ttlMs;
      await db.run(
        "INSERT INTO kv_cache (k, v, expires_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(k) DO UPDATE SET v = excluded.v, expires_at = excluded.expires_at",
        [key, JSON.stringify(value), expires],
      );
    },

    /** Return the cached value or compute, store, and return it. */
    async wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
      const hit = await this.get<T>(key);
      if (hit !== null) return hit;
      const fresh = await fn();
      await this.set(key, fresh, ttlMs);
      return fresh;
    },
  };
}

export type Cache = ReturnType<typeof createCache>;
