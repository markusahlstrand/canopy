import type { AiMessage, AiModel } from "@canopy/core";
import type { PluginPlace, PluginSettings } from "./settings";

export type { AiMessage, AiModel };

/** A drive file as plugins see it — the minimal shape the host's file methods return. */
export interface PluginFile {
  id: string;
  name: string;
  /** Containing directory path, when the host knows it. */
  path?: string;
  /** "folder" for directories, a file kind otherwise. */
  kind?: string;
}

/** A space as plugins see it — the minimal shape the host's space methods return. */
export interface PluginSpace {
  id: string;
  name: string;
}

/** Result of probing or syncing a connector-backed plugin. */
export interface ConnectorResult {
  ok: boolean;
  error?: string;
}

/** An inference request, mirroring the host AI gateway (model optional → host default). */
export interface PluginAiRequest {
  messages: AiMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
}

/**
 * The capabilities a trusted plugin reaches the host through. The app implements
 * this once (wrapping its API client + imperative host actions); plugins call it
 * via {@link usePluginHost} instead of importing app internals like `@/lib/api`.
 *
 * Keep this surface small and generic — anything added here is offered to *every*
 * plugin, so it must read as a host capability, never as one plugin's hook. Swapping
 * the implementation is what lets the same plugin run in a different host (e.g. a
 * VS Code webview).
 */
export interface HostBridge {
  /** True while the client is online; drive mutations are blocked offline. */
  readonly online: boolean;
  /** Read a file's current text by id. */
  readFileText(id: string): Promise<string>;
  /** Save a new version of an existing file. */
  saveFileVersion(id: string, text: string, mime?: string): Promise<void>;
  /** Create a file in a folder (optionally within a space) and return it. */
  createFile(dir: string, name: string, content: string, mime?: string, spaceId?: string): Promise<PluginFile>;
  /** Look up a file's metadata by id, or null if it's gone. */
  getFile(id: string): Promise<PluginFile | null>;
  /** List files in a folder (optionally within a space). */
  listFiles(dir?: string, spaceId?: string): Promise<PluginFile[]>;
  /** Create a file at the drive root and open it full-screen; null if blocked (offline) or failed. */
  createAndOpenFile(input: { name: string; content: string; mime?: string }): Promise<PluginFile | null>;
  /** Run inference through the host's AI gateway (the caller never holds a key). Throws on failure. */
  aiGenerate(req: PluginAiRequest): Promise<string>;
  /** Models the deployment exposes, or [] when no AI provider is configured. */
  listAiModels(): Promise<AiModel[]>;

  // ── Plugin settings (a generic plugin concept; see PluginSettingsDialog) ──
  /** The plugin's config schema + current values, or null if it has none. */
  getPluginSettings(pluginId: string): Promise<PluginSettings | null>;
  /** Persist the plugin's config values (secrets left blank keep their stored value). */
  savePluginSettings(pluginId: string, values: Record<string, string>): Promise<void>;
  /** Group spaces the caller owns, each flagged with whether the plugin is applied. */
  getPluginPlaces(pluginId: string): Promise<PluginPlace[]>;
  /** Turn the plugin on for everyone in a space. */
  applySpacePlugin(spaceId: string, pluginId: string): Promise<void>;
  /** Turn the plugin off for a space. */
  removeSpacePlugin(spaceId: string, pluginId: string): Promise<void>;

  // ── Connector-backed spaces (a plugin that mounts external storage) ──
  /** The spaces the caller can see (used to resolve a connector's space). */
  listSpaces(): Promise<PluginSpace[]>;
  /** Trigger a sync of the plugin's connector. */
  syncConnector(pluginId: string): Promise<ConnectorResult>;
  /** Probe the plugin's connector (host + credentials) without syncing. */
  testConnector(pluginId: string): Promise<ConnectorResult>;

  // ── Reading a named drive mount (e.g. bundled documentation) ──
  /** List entries under `path` within a named mount. */
  listMount(path: string, mount: string): Promise<PluginFile[]>;
  /** Read a text file by path within a named mount. */
  readMountText(path: string, mount: string): Promise<string>;
  /** A direct content URL for a path within a named mount (e.g. an <img> src). */
  mountFileUrl(path: string, mount: string): string;
}
