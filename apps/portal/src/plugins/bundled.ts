import type { PluginManifest } from "@canopy/core";
import { BUNDLED_MANIFESTS } from "./bundled-manifests";
// Each bundled plugin's ESM entry, pulled as raw text and handed to the
// sandboxed iframe at preview time — the same path a resolved third-party plugin
// (zip/github/npm) would take, just without a fetch. Kept out of
// ./bundled-manifests so importing the catalog doesn't drag plugin source along.
import imageSource from "../../../../examples/plugins/image-viewer/index.js?raw";
import pdfSource from "../../../../examples/plugins/pdf-viewer/index.js?raw";
import markdownSource from "../../../../examples/plugins/markdown-editor/index.js?raw";
import codeSource from "../../../../examples/plugins/code-editor/index.js?raw";
import univerSource from "../../../../examples/plugins/univer-office/index.js?raw";

const SOURCE_BY_ID: Record<string, string> = {
  "image-viewer": imageSource,
  "pdf-viewer": pdfSource,
  "markdown-editor": markdownSource,
  "code-editor": codeSource,
  "univer-office": univerSource,
};

/** A bundled plugin: its manifest paired with the entry source for the sandbox. */
export interface BundledPlugin {
  manifest: PluginManifest;
  source: string;
}

export const BUNDLED_PLUGINS: BundledPlugin[] = BUNDLED_MANIFESTS.map((manifest) => ({
  manifest,
  source: SOURCE_BY_ID[manifest.id] ?? "",
}));
