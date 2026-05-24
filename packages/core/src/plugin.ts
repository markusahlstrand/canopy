import type { Contributions } from "./contributions";

/**
 * Capabilities a plugin must declare in its manifest. The host grants only what
 * is declared, as a scoped binding object — plugins never get ambient access.
 */
export type Capability =
  | { kind: "item:read" }
  | { kind: "item:write" }
  | { kind: "index:query" }
  | { kind: "storage:read"; connectors?: string[] }
  | { kind: "net:fetch"; hosts: string[] }
  | { kind: "kv" }
  | { kind: "ai:generate"; models?: string[] };

/** Server-side hooks a plugin can implement; these run inside the sandbox. */
export type ServerHook = "enrichItem" | "transformUpload";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** lucide icon name for sidebar / rail / store surfaces. */
  icon?: string;
  /** hsl() accent string for tinted icon backgrounds. */
  color?: string;
  /** Entry module path within the source (folder/zip), relative to the manifest. */
  entry?: string;
  capabilities: Capability[];
  serverHooks?: ServerHook[];
  contributes?: Contributions;
}

/**
 * The runtime-agnostic bundle the host produces once and any PluginRuntime
 * adapter can execute. Worker Loader takes mainModule/modules directly; the
 * Node (isolated-vm) adapter evaluates the same source.
 */
export interface PluginBundle {
  manifest: PluginManifest;
  /** ESM source for the entry module. */
  mainModule: string;
  /** Additional modules by import specifier. */
  modules?: Record<string, string>;
}
