import type { PluginManifest } from "@canopy/core";
// The bundled sample plugins live in /examples/plugins. We pull each plugin's
// canopy.json as raw text and parse it, so the manifest is the single source of
// truth for everything the host shows about that plugin — its store listing, the
// file types it views (`contributes.viewers`), and the files it creates
// (`contributes.creators`). The host never re-declares any of this.
import imageManifest from "../../../../examples/plugins/image-viewer/canopy.json?raw";
import pdfManifest from "../../../../examples/plugins/pdf-viewer/canopy.json?raw";
import markdownManifest from "../../../../examples/plugins/markdown-editor/canopy.json?raw";
import codeManifest from "../../../../examples/plugins/code-editor/canopy.json?raw";
import univerManifest from "../../../../examples/plugins/univer-office/canopy.json?raw";
// Model Editor is a trusted first-party React view, not a sandboxed ESM plugin:
// it ships a manifest (catalog listing + standalone app + .prisma viewer/creator)
// but no index.js source, so its sandbox source resolves to "". The host renders
// its React components through the trusted PLUGIN_UI registry (DetailView + FileView,
// keyed by plugin id), the same path as tasks/documentation — no per-plugin host code.
import modelManifest from "../../../../examples/plugins/model-editor/canopy.json?raw";

/**
 * Manifests for the plugins compiled into this build. Order here is the order
 * they appear in the store / sidebar (after the first-party feature plugins).
 * This module is manifest-only (no plugin source) so it's cheap to import from
 * the catalog and registry; the matching ESM sources live in {@link ./bundled}.
 */
export const BUNDLED_MANIFESTS: PluginManifest[] = [
  imageManifest,
  pdfManifest,
  markdownManifest,
  codeManifest,
  univerManifest,
  modelManifest,
].map((raw) => JSON.parse(raw) as PluginManifest);

export const BUNDLED_MANIFEST_BY_ID = new Map(BUNDLED_MANIFESTS.map((m) => [m.id, m]));
