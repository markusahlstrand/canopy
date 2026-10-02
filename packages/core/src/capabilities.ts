import type { PluginManifest } from "./plugin";
import type { CapabilityGrants } from "./runtime";
import { scopedCache, type CacheStore } from "./cache";
import { scopedQueryIndex, type SearchIndex, type SearchScope } from "./search";

/**
 * The capability broker: turns a plugin's *declared* capabilities into the
 * *concrete*, scoped host functions it's allowed to call (CapabilityGrants).
 * A PluginRuntime adapter (cf-loader / isolated-vm) then injects these into the
 * sandbox. This module only mints the grants that are purely host-derived; the
 * runtime supplies the rest (`fetch` with host allowlists, `getItem`, etc.).
 */

const DEFAULT_KV_TTL_MS = 5 * 60 * 1000;

/** Back a plugin's `kv` grant with an (already-scoped) CacheStore. */
export function kvGrant(cache: CacheStore, ttlMs = DEFAULT_KV_TTL_MS): NonNullable<CapabilityGrants["kv"]> {
  return {
    async get(key: string) {
      return (await cache.get<string>(key)) ?? null;
    },
    async put(key: string, value: string) {
      await cache.set(key, value, ttlMs);
    },
  };
}

/**
 * Build the grants a plugin is entitled to. Wires the `kv` capability
 * to a cache namespaced per **plugin + user**, so plugins can't read each other's
 * (or other users') cached data. `index:query` requires an identified caller and
 * a trusted host scope resolver. Other capabilities are layered on by the host.
 */
export function grantsForManifest(
  manifest: PluginManifest,
  deps: {
    cache?: CacheStore;
    userSub?: string;
    search?: SearchIndex;
    /** Trusted host lookup, never provided by plugin code. */
    resolveSearchScope?: (userSub: string) => Promise<SearchScope>;
  },
): CapabilityGrants {
  const grants: CapabilityGrants = {};
  for (const cap of manifest.capabilities) {
    if (cap.kind === "kv" && deps.cache) {
      const ns = `plugin:${manifest.id}:user:${deps.userSub ?? "anon"}`;
      grants.kv = kvGrant(scopedCache(deps.cache, ns));
    }
    if (cap.kind === "index:query" && deps.search && deps.userSub && deps.resolveSearchScope) {
      const sub = deps.userSub;
      const resolve = deps.resolveSearchScope;
      grants.queryIndex = scopedQueryIndex(deps.search, () => resolve(sub));
    }
  }
  return grants;
}
