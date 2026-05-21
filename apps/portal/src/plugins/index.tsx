import { lazy, type ComponentType } from "react";
import { PluginRegistry } from "@canopy/core";
import { buildManifest } from "./manifests";
import { CalendarPanel, TasksPanel } from "./rail-panels";
import { CalendarWeekView, TasksKanban } from "./detail-views";

// Lazy-loaded: pulls react-markdown + remark-gfm into a separate chunk.
const DocsView = lazy(() => import("./docs-view").then((m) => ({ default: m.DocsView })));

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
  docs: { DetailView: DocsView },
  calendar: { RailPanel: CalendarPanel, DetailView: CalendarWeekView },
  tasks: { RailPanel: TasksPanel, DetailView: TasksKanban },
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

export { DEFAULT_INSTALLED } from "./manifests";
