import type { Contributions, PluginManifest } from "@canopy/core";
import { PLUGIN_CATALOG } from "@/lib/mock-data";
import { BUNDLED_MANIFEST_BY_ID } from "./bundled-manifests";

/** Rich contributions for first-party plugins that ship real UI. */
const RICH_CONTRIBUTIONS: Record<string, Contributions> = {
  documentation: {
    detailView: { id: "documentation-detail", title: "Documentation", nav: { section: "Apps" } },
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
  synology: {
    detailView: { id: "synology-detail", title: "Synology" },
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
};

/**
 * Build the manifest for an installed plugin id. Bundled plugins ship a real
 * manifest (capabilities + viewers/creators), so we return it verbatim; the
 * first-party feature plugins are assembled from the store catalog plus the
 * rich-contribution/capability overrides above.
 */
export function buildManifest(id: string): PluginManifest | undefined {
  const bundled = BUNDLED_MANIFEST_BY_ID.get(id);
  if (bundled) return bundled;
  if (id === WELCOME_PLUGIN_ID) return WELCOME_MANIFEST;
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

/**
 * The Welcome / marketing landing — the signed-out experience. Not an installable
 * store app (deliberately absent from PLUGIN_CATALOG), so its manifest is authored
 * here and returned directly from buildManifest. Renders immersive (edge-to-edge,
 * no plugin header) and contributes no nav entry — it's reached via the signed-out
 * landing redirect (see App.tsx) and `?view=plugin:welcome`.
 */
export const WELCOME_PLUGIN_ID = "welcome";

const WELCOME_MANIFEST: PluginManifest = {
  id: WELCOME_PLUGIN_ID,
  name: "Welcome",
  version: "0.1.0",
  icon: "home",
  color: "145 33% 36%", // Canopy green
  capabilities: [], // static marketing page — reads nothing from the host
  contributes: {
    detailView: { id: "welcome-detail", title: "Welcome", immersive: true },
  },
};

/**
 * Plugins installed by default for signed-in users. Includes the baseline file
 * viewers (image/pdf/markdown) so common file types preview out of the box;
 * other viewers (code, univer) are installed from the store on demand.
 */
export const DEFAULT_INSTALLED = [
  "calendar",
  "tasks",
  "image-viewer",
  "pdf-viewer",
  "markdown-editor",
  "model-editor",
];

/**
 * Signed-out / anonymous visitors land on Welcome (the marketing page) and also
 * get Documentation so they can browse the guides. Signed-in users get neither by
 * default (Welcome isn't installable; Documentation installs from the store).
 */
export const ANON_DEFAULT_INSTALLED = [WELCOME_PLUGIN_ID, DOCS_PLUGIN_ID, ...DEFAULT_INSTALLED];
