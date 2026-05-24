import type { Contributions, PluginManifest } from "@canopy/core";
import { PLUGIN_CATALOG } from "@/lib/mock-data";

/** Rich contributions for first-party plugins that ship real UI. */
const RICH_CONTRIBUTIONS: Record<string, Contributions> = {
  documentation: {
    detailView: { id: "documentation-detail", title: "Documentation" },
  },
  calendar: {
    railPanel: { id: "calendar-rail", title: "Calendar", icon: "calendar" },
    detailView: { id: "calendar-detail", title: "Calendar" },
    contextMenu: [
      { id: "calendar.add", label: "Add to calendar", icon: "calendar-plus", when: { kinds: ["pdf", "doc", "note"] } },
    ],
  },
  tasks: {
    detailView: { id: "tasks-detail", title: "Tasks" },
    contextMenu: [{ id: "tasks.create", label: "Create task from file", icon: "circle-check" }],
  },
  github: {
    detailView: { id: "github-detail", title: "GitHub" },
    dataSource: { provides: ["tasks", "calendar"] },
  },
  "document-ai": {
    detailView: { id: "document-ai-detail", title: "Document AI" },
  },
};

/** Capability overrides for plugins that don't use the default item:read grant. */
const CAPABILITY_OVERRIDES: Record<string, PluginManifest["capabilities"]> = {
  github: [{ kind: "net:fetch", hosts: ["api.github.com"] }],
  // Document AI reads each added file and writes a type label to its metadata, via Gemini.
  "document-ai": [{ kind: "net:fetch", hosts: ["generativelanguage.googleapis.com"] }, { kind: "item:read" }, { kind: "item:write" }],
  // Documentation reads markdown from the read-only `documentation` storage mount.
  documentation: [{ kind: "storage:read", connectors: ["documentation"] }],
  // Code Editor reads a file's source and writes edits back to that same file.
  "code-editor": [{ kind: "item:read" }, { kind: "item:write" }],
};

/** Build a manifest for an installed plugin id from the store catalog. */
export function buildManifest(id: string): PluginManifest | undefined {
  const cat = PLUGIN_CATALOG.find((c) => c.id === id);
  if (!cat) return undefined;
  return {
    id: cat.id,
    name: cat.label,
    version: "0.1.0",
    icon: cat.icon,
    color: cat.color,
    capabilities: CAPABILITY_OVERRIDES[id] ?? [{ kind: "item:read" }],
    contributes: {
      store: { category: cat.category, tagline: cat.tagline, popular: cat.popular },
      ...RICH_CONTRIBUTIONS[id],
    },
  };
}

export const DOCS_PLUGIN_ID = "documentation";

/** Plugins installed by default for signed-in users. */
export const DEFAULT_INSTALLED = ["calendar", "tasks"];

/**
 * Signed-out / anonymous visitors also get Documentation, which doubles as the
 * landing experience. Signed-in users install it from the store if they want it.
 */
export const ANON_DEFAULT_INSTALLED = [DOCS_PLUGIN_ID, ...DEFAULT_INSTALLED];
