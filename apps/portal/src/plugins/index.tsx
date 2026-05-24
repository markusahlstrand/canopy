import { lazy, type ComponentType } from "react";
import { PluginRegistry } from "@canopy/core";
import { buildManifest } from "./manifests";
import { TasksView } from "./detail-views";
import { GithubView } from "./github-view";
import { DocumentAiView } from "./document-ai-view";

// Lazy-loaded: pulls react-markdown + remark-gfm into a separate chunk.
const DocumentationView = lazy(() => import("./documentation-view").then((m) => ({ default: m.DocumentationView })));

/**
 * Host-side render map for plugin UI contributions. Manifests stay declarative
 * in @canopy/core; the actual React components for each contribution live here.
 * This is the **trusted, first-party tier**: components compiled into the host
 * with full React + API access. Untrusted/third-party UI goes through the
 * sandboxed slot path instead (see {@link sandboxedSlot} / UI_PLUGINS) — calendar
 * has been migrated there as the reference implementation.
 */
export interface PluginUI {
  RailPanel?: ComponentType;
  DetailView?: ComponentType;
}

export const PLUGIN_UI: Record<string, PluginUI> = {
  documentation: { DetailView: DocumentationView },
  tasks: { DetailView: TasksView },
  github: { DetailView: GithubView },
  "document-ai": { DetailView: DocumentAiView },
};

/** Build a registry holding the manifests for the given installed plugin ids. */
export function createRegistry(installedIds: string[]): PluginRegistry {
  const registry = new PluginRegistry();
  for (const id of installedIds) {
    const manifest = buildManifest(id);
    if (manifest) registry.register(manifest);
  }
  return registry;
}

export { DEFAULT_INSTALLED, ANON_DEFAULT_INSTALLED, DOCS_PLUGIN_ID } from "./manifests";
