import { lazy, type ComponentType } from "react";
import { PluginRegistry, type PluginManifest } from "@canopy/core";
import { buildManifest } from "./manifests";
import { TasksView } from "./detail-views";
import { GithubView } from "./github-view";
import { SynologyView } from "./synology-view";
import { DocumentAiView } from "./document-ai-view";

// Lazy-loaded: pulls react-markdown + remark-gfm into a separate chunk.
const DocumentationView = lazy(() => import("./documentation-view").then((m) => ({ default: m.DocumentationView })));
// Model Editor is a trusted first-party React app (React Flow) bound to file types
// only — it's a viewer/editor for `.prisma`/`.tsp`/`.arazzo`, not a standalone app.
// Lazy so its heavy deps stay out of the main bundle until a matching file opens.
// Routes a matched file to the right canvas: `.prisma` → the Prisma model editor,
// `.tsp`/`.arazzo` → the spec editor (TypeSpec + Arazzo, with cross-layer links).
const ModelEditorFileView = lazy(() =>
  import("@/components/model-editor/file-router").then((m) => ({ default: m.ModelEditorFileRouter })),
);

/**
 * Host-side render map for plugin UI contributions. Manifests stay declarative
 * in @canopy/core; the actual React components for each contribution live here.
 * This is the **trusted, first-party tier**: components compiled into the host
 * with full React + API access. Untrusted/third-party UI goes through the
 * sandboxed slot path instead (see {@link sandboxedSlot} / UI_PLUGINS) — calendar
 * has been migrated there as the reference implementation.
 */
/** Props the host passes to a trusted React file viewer ({@link PluginUI.FileView}). */
export interface FileViewProps {
  fileId: string;
  fileName: string;
  /** Space the file lives in, when known — lets a viewer list sibling files. */
  spaceId?: string;
  /** The file's full drive path, when known — used to scope folder discovery. */
  filePath?: string;
  /** Called after the viewer saves a new version, so the host can refresh. */
  onSaved?: () => void;
}

export interface PluginUI {
  RailPanel?: ComponentType;
  DetailView?: ComponentType;
  /**
   * A trusted React viewer for the plugin's file types — the in-process
   * counterpart of a sandboxed `contributes.viewers` entry, for first-party views
   * that need full React/host access (e.g. a canvas editor). The host renders this
   * instead of an iframe when a matching file opens.
   */
  FileView?: ComponentType<FileViewProps>;
}

export const PLUGIN_UI: Record<string, PluginUI> = {
  documentation: { DetailView: DocumentationView },
  tasks: { DetailView: TasksView },
  github: { DetailView: GithubView },
  synology: { DetailView: SynologyView },
  "document-ai": { DetailView: DocumentAiView },
  "model-editor": { FileView: ModelEditorFileView },
};

/**
 * Build a registry holding the manifests for the given installed plugin ids.
 * `customManifests` are AI-generated (Plugin Studio) plugins, whose manifests are
 * authored at runtime rather than derived from the catalog; they're registered
 * when their id is in the active set, the same gate as catalog plugins.
 */
export function createRegistry(installedIds: string[], customManifests: PluginManifest[] = []): PluginRegistry {
  const registry = new PluginRegistry();
  for (const id of installedIds) {
    const manifest = buildManifest(id);
    if (manifest) registry.register(manifest);
  }
  for (const manifest of customManifests) {
    if (installedIds.includes(manifest.id)) registry.register(manifest);
  }
  return registry;
}

export { DEFAULT_INSTALLED, ANON_DEFAULT_INSTALLED, DOCS_PLUGIN_ID } from "./manifests";
