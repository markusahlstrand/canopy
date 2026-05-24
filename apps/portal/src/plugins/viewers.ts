import { viewerMatches, type FileCreatorContribution, type ViewerContribution } from "@canopy/core";
// Sample viewer plugins live in /examples/plugins. We pull their entry source as
// raw text and hand it to the sandboxed iframe at preview time — the same path a
// resolved third-party plugin (zip/github/npm) would take, just without a fetch.
import imageViewerSource from "../../../../examples/plugins/image-viewer/index.js?raw";
import pdfViewerSource from "../../../../examples/plugins/pdf-viewer/index.js?raw";
import markdownEditorSource from "../../../../examples/plugins/markdown-editor/index.js?raw";

/** A viewer the host can mount: a contribution plus the code that implements it. */
export interface InstalledViewer extends ViewerContribution {
  /** Owning plugin id. */
  plugin: string;
  /** ESM entry source handed to the sandbox. */
  source: string;
}

/**
 * Viewers available to the preview surface. In production this list is built
 * from installed plugins' `contributes.viewers`; here we register the two
 * bundled samples directly.
 */
export const VIEWERS: InstalledViewer[] = [
  {
    plugin: "markdown-editor",
    id: "markdown",
    title: "Markdown",
    match: ["text/markdown", ".md", ".markdown", ".mdx"],
    source: markdownEditorSource,
  },
  {
    plugin: "image-viewer",
    id: "image",
    title: "Image",
    match: ["image/*", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".heic", ".avif"],
    source: imageViewerSource,
  },
  {
    plugin: "pdf-viewer",
    id: "pdf",
    title: "PDF",
    match: ["application/pdf", ".pdf"],
    source: pdfViewerSource,
  },
];

/** First viewer whose `match` covers this file, or undefined. */
export function findViewer(name: string, mime?: string): InstalledViewer | undefined {
  const ext = name.split(".").pop();
  return VIEWERS.find((v) => viewerMatches(v.match, { mime, ext }));
}

/** A new-file type the host's "New" menu can offer: a contribution + its owning plugin. */
export interface InstalledCreator extends FileCreatorContribution {
  /** Owning plugin id. */
  plugin: string;
}

/**
 * File types offerable from the "New" menu, built from installed plugins'
 * `contributes.creators`. Mirrors VIEWERS — here the bundled markdown editor is
 * registered directly; in production this is derived from installed manifests.
 */
export const CREATORS: InstalledCreator[] = [
  {
    plugin: "markdown-editor",
    id: "markdown",
    label: "Markdown document",
    icon: "file-text",
    defaultName: "Untitled",
    extension: ".md",
    mime: "text/markdown",
    template: "# Untitled\n\n",
  },
];
