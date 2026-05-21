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
};

/**
 * Built-in plugins that ship with the host and aren't published in the store
 * catalog. Docs reads markdown from the `docs` storage mount — a plugin that
 * combines a storage-read capability with a UI contribution.
 */
const BUILTIN_MANIFESTS: Record<string, PluginManifest> = {
  docs: {
    id: "docs",
    name: "Docs",
    version: "0.1.0",
    icon: "book",
    color: "212 70% 48%",
    capabilities: [{ kind: "storage:read", connectors: ["docs"] }],
    contributes: {
      detailView: { id: "docs-detail", title: "Docs" },
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
    capabilities: [{ kind: "item:read" }],
    contributes: {
      store: { category: cat.category, tagline: cat.tagline, popular: cat.popular },
      ...RICH_CONTRIBUTIONS[id],
    },
  };
}

export const DEFAULT_INSTALLED = ["docs", "calendar", "tasks"];
