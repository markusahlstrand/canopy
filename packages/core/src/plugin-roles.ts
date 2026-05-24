import type { AiGateway } from "./ai";
import type { CacheStore } from "./cache";
import type { CalendarProvider, TaskProvider } from "./providers";
import type { ConnectorConfigField, StorageConnectorPlugin } from "./storage";
import type { PluginManifest } from "./plugin";

/**
 * Trusted, in-process **role contracts**. A plugin is one package; these are the
 * server-side roles it can fill. Each runs inside the API process — it holds
 * secrets and/or *is* the I/O boundary — so none of these are sandboxed. That's a
 * property of the role, not of the plugin, and a single plugin may fill several.
 *
 * The sandboxed / declarative roles (file viewers, UI surfaces, server hooks) are
 * declared on the {@link PluginManifest}'s `contributes` / `serverHooks` instead;
 * they receive only what the capability broker grants, never a privileged factory
 * like the contracts here. See documentation/03-how-plugins-work.md.
 */

/* ── Data-source role ──────────────────────────────────────────────────────── */

/**
 * Serves typed records (tasks, calendar events) into the host plugins,
 * normalizing some external system. Trusted: it holds tokens and calls
 * third-party APIs. It declares its config schema (rendered as a generic settings
 * form, so secrets never round-trip to render it) and builds typed providers from
 * a saved, decrypted config. The host hands it an already-scoped CacheStore; the
 * adapter owns its own TTL policy, so it caches identically on Node and Cloudflare.
 */
export interface ServerDataSource {
  id: string;
  configFields: ConnectorConfigField[];
  /** Build providers from a resolved (decrypted) config; returns what it can. */
  build(
    config: Record<string, string>,
    ctx?: { cache?: CacheStore },
  ): { tasks?: TaskProvider; calendar?: CalendarProvider };
}

/* ── Processor role ────────────────────────────────────────────────────────── */

export interface ProcessorFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

/** Host capabilities handed to a processor when it runs. */
export interface ProcessorContext {
  /** The deployment's AI gateway, if any provider is configured. */
  ai?: AiGateway;
}

/** What a processor produces for one file. */
export interface ProcessorResult {
  /** Type labels to merge into metadata.labels. */
  labels: string[];
  /** A generated description for metadata.description (only set if absent). */
  description?: string;
  /** Identifier of the model/engine used, for the processing log. */
  model?: string;
  /** Set when the run failed; recorded in the processing log, never thrown. */
  error?: string;
}

/**
 * Runs when a file is added and derives metadata to merge into it (type labels, a
 * description). Trusted, in-process — the server-side form of the planned
 * `enrichItem` / `transformUpload` sandbox hooks. Inference goes through the host
 * AI gateway (via `ctx`), never a key the processor holds.
 */
export interface DocumentProcessor {
  id: string;
  configFields: ConnectorConfigField[];
  /**
   * Whether to run for the given user config + host context. Defaults (when
   * omitted) to "all required config fields are present".
   */
  eligible?(config: Record<string, string>, ctx: ProcessorContext): boolean;
  /** Analyze a freshly-added file and return labels / description to merge. */
  process(file: ProcessorFile, config: Record<string, string>, ctx: ProcessorContext): Promise<ProcessorResult>;
}

/* ── The plugin: one package, the roles it fills ───────────────────────────── */

/**
 * A plugin is one package with an identity and a manifest; the fields below are
 * the trusted, in-process **roles** it provides. A single plugin can fill several
 * at once (a connector *and* a data source *and* a processor — e.g. a "Google
 * Drive" plugin). The host registers the whole thing once and fans each role into
 * the subsystem that runs it.
 *
 * `manifest` is optional for now: first-party plugins still declare their manifest
 * client-side in the portal, so server-side registration is keyed by `id`. As the
 * manifest converges to one source of truth this becomes the single front door for
 * every role — see the "Combining roles" section in documentation/03.
 */
export interface ServerPlugin {
  id: string;
  manifest?: PluginManifest;
  connectors?: StorageConnectorPlugin[];
  dataSource?: ServerDataSource;
  processors?: DocumentProcessor[];
}
