import type { Contributions, PluginManifest } from "@canopy/core";
import { PLUGIN_CATALOG } from "@/lib/mock-data";

/** Rich contributions for first-party plugins that ship real UI. */
const RICH_CONTRIBUTIONS: Record<string, Contributions> = {
  calendar: {
    railPanel: { id: "calendar-rail", title: "Calendar", icon: "calendar" },
    detailView: { id: "calendar-detail", title: "Calendar" },
    contextMenu: [
      { id: "calendar.add", label: "Add to calendar", icon: "calendar-plus", when: { kinds: ["pdf", "doc", "note"] } },
    ],
  },
  tasks: {
    railPanel: { id: "tasks-rail", title: "Tasks", icon: "check-square" },
    detailView: { id: "tasks-detail", title: "Tasks" },
    contextMenu: [{ id: "tasks.create", label: "Create task from file", icon: "circle-check" }],
  },
  github: {
    detailView: { id: "github-detail", title: "GitHub" },
    dataSource: { provides: ["tasks", "calendar"] },
  },
};

/** Plugin ids whose contribution is a data source (no item access). */
const DATA_SOURCE_CAPS: Record<string, PluginManifest["capabilities"]> = {
  github: [{ kind: "net:fetch", hosts: ["api.github.com"] }],
};

/**
 * Built-in plugins that ship with the host and aren't published in the store
 * catalog. Documentation reads markdown from the `documentation` storage mount — a plugin that
 * combines a storage-read capability with a UI contribution.
 */
const BUILTIN_MANIFESTS: Record<string, PluginManifest> = {
  documentation: {
    id: "documentation",
    name: "Documentation",
    version: "0.1.0",
    icon: "book",
    color: "212 70% 48%",
    capabilities: [{ kind: "storage:read", connectors: ["documentation"] }],
    contributes: {
      detailView: { id: "documentation-detail", title: "Documentation" },
    },
  },
};

/** Build a manifest for an installed plugin id (built-in or from the catalog). */
export function buildManifest(id: string): PluginManifest | undefined {
  if (BUILTIN_MANIFESTS[id]) return BUILTIN_MANIFESTS[id];
  const cat = PLUGIN_CATALOG.find((c) => c.id === id);
  if (!cat) return undefined;
  return {
    id: cat.id,
    name: cat.label,
    version: "0.1.0",
    icon: cat.icon,
    color: cat.color,
    capabilities: DATA_SOURCE_CAPS[id] ?? [{ kind: "item:read" }],
    contributes: {
      store: { category: cat.category, tagline: cat.tagline, popular: cat.popular },
      ...RICH_CONTRIBUTIONS[id],
    },
  };
}

export const DEFAULT_INSTALLED = ["documentation", "calendar", "tasks"];
