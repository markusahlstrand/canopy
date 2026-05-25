import type { DocumentProcessor, ServerDataSource, ServerPlugin } from "@canopy/core";
import { synologyConnectorPlugin } from "@canopy/connector-synology";
import { githubDataSource, synologyDataSource } from "./data-sources";
import { documentAiProcessor } from "./processors";

/**
 * First-party plugins. Each is **one package** that declares whatever server-side
 * roles it fills — the GitHub plugin fills the `data-source` role, Document AI the
 * `processor` role — and this single list registers them all. A plugin that needs
 * several roles (a connector *and* a data source *and* a processor — e.g. a Google
 * Drive integration) just sets more fields on its entry; nothing else changes.
 * See the "Combining roles" section in documentation/03-how-plugins-work.md.
 */
export const SERVER_PLUGINS: ServerPlugin[] = [
  { id: "github", dataSource: githubDataSource },
  { id: "synology", dataSource: synologyDataSource, connectors: [synologyConnectorPlugin] },
  { id: "document-ai", processors: [documentAiProcessor] },
];

/** The data-source roles across all plugins (what `createApp` consumes today). */
export const dataSourcesOf = (plugins: ServerPlugin[]): ServerDataSource[] =>
  plugins.flatMap((p) => (p.dataSource ? [p.dataSource] : []));

/** The processor roles across all plugins. */
export const processorsOf = (plugins: ServerPlugin[]): DocumentProcessor[] =>
  plugins.flatMap((p) => p.processors ?? []);
