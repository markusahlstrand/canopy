import type { PluginManifest } from "./plugin";

/**
 * Where a plugin's code + manifest come from. Each variant is resolved by a
 * source adapter (see @canopy/plugin-sources) to a common ResolvedPlugin, so
 * the registry/runtime stay source-agnostic.
 */
export type PluginSourceRef =
  | { type: "github"; repo: string; ref?: string; path?: string } // "owner/repo", branch|tag|sha, subfolder
  | { type: "npm"; name: string; version?: string } // exact version or dist-tag (default "latest")
  | { type: "zip"; key: string }; // storage key of an uploaded archive

/**
 * A plugin's entry code, either as a URL to import (npm CDN / GitHub raw) or as
 * inline source (an unpacked zip). The runtime loads whichever is present.
 */
export type PluginEntry = { url: string } | { code: string; modules?: Record<string, string> };

/** The normalized result of resolving any PluginSourceRef. */
export interface ResolvedPlugin {
  manifest: PluginManifest;
  entry: PluginEntry;
  /** Concrete resolved version (manifest version, npm version, or commit sha). */
  version: string;
  source: PluginSourceRef;
}

/** Adapter that turns a source ref into a runnable plugin and reports updates. */
export interface PluginSource {
  readonly type: PluginSourceRef["type"];
  resolve(ref: PluginSourceRef): Promise<ResolvedPlugin>;
  /** null when current; otherwise the available update. */
  checkUpdate(ref: PluginSourceRef, installedVersion: string): Promise<{ current: string; latest: string } | null>;
}
