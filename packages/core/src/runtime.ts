import type { PluginBundle } from "./plugin";
import type { Page } from "./storage";
import type { SearchHit, SearchQuery } from "./search";

/**
 * The concrete, scoped host functions granted to a running plugin instance,
 * derived by the capability broker from the plugin's declared capabilities.
 * Each PluginRuntime adapter injects these in its own way:
 *  - cf-loader: as `env` bindings + globalOutbound on the loaded Worker
 *  - cf-wfp:    as tenant bindings + an outbound Worker
 *  - node:      as the restricted object passed into the isolated-vm context
 */
export interface CapabilityGrants {
  /** Scoped fetch — only resolves hosts the plugin was granted. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Read-only item access, if granted. */
  getItem?: (id: string) => Promise<unknown>;
  /**
   * Index query, if granted. The plugin supplies only a `SearchQuery`; the host
   * resolves the caller's readable spaces and applies the `SearchScope` itself,
   * so a plugin can't search spaces it can't read.
   */
  queryIndex?: (query: SearchQuery) => Promise<Page<SearchHit>>;
  /** Namespaced KV, if granted. */
  kv?: { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> };
}

export interface PluginInstance {
  readonly id: string;
  dispose(): Promise<void> | void;
}

/**
 * Switchable sandbox adapter. The capability broker (what a plugin is granted)
 * is runtime-agnostic; only the injection + execution mechanics differ here.
 */
export interface PluginRuntime {
  /** "node" | "cf-loader" | "cf-wfp" */
  readonly id: string;
  load(bundle: PluginBundle, grants: CapabilityGrants): Promise<PluginInstance>;
  invoke<TIn, TOut>(instance: PluginInstance, hook: string, input: TIn): Promise<TOut>;
}
