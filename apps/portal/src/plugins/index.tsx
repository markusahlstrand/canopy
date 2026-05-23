import { lazy, type ComponentType } from "react";
import { PluginRegistry } from "@canopy/core";
import { buildManifest } from "./manifests";
import { CalendarPanel } from "./rail-panels";
import { CalendarView, TasksView } from "./detail-views";
import { GithubView } from "./github-view";
import { DocumentAiView } from "./document-ai-view";

// Lazy-loaded: pulls react-markdown + remark-gfm into a separate chunk.
const DocumentationView = lazy(() => import("./documentation-view").then((m) => ({ default: m.DocumentationView })));

/**
 * Host-side render map for plugin UI contributions. Manifests stay declarative
 * in @canopy/core; the actual React components for each contribution live here.
 * First-party plugins go through the same registry + slots a third-party plugin
 * would use.
 */
export interface PluginUI {
  RailPanel?: ComponentType;
  DetailView?: ComponentType;
}

export const PLUGIN_UI: Record<string, PluginUI> = {
  documentation: { DetailView: DocumentationView },
  calendar: { RailPanel: CalendarPanel, DetailView: CalendarView },
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
