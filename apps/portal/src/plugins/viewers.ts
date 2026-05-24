import { viewerMatches, type FileCreatorContribution, type ViewerContribution } from "@canopy/core";
import { PLUGIN_CATALOG } from "@/lib/mock-data";
// Sample viewer plugins live in /examples/plugins. We pull their entry source as
// raw text and hand it to the sandboxed iframe at preview time — the same path a
// resolved third-party plugin (zip/github/npm) would take, just without a fetch.
import imageViewerSource from "../../../../examples/plugins/image-viewer/index.js?raw";
import pdfViewerSource from "../../../../examples/plugins/pdf-viewer/index.js?raw";
import markdownEditorSource from "../../../../examples/plugins/markdown-editor/index.js?raw";
import codeEditorSource from "../../../../examples/plugins/code-editor/index.js?raw";
import univerOfficeSource from "../../../../examples/plugins/univer-office/index.js?raw";

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
    plugin: "univer-office",
    id: "univer",
    title: "Univer Office",
    // Spreadsheets/docs: delimited text + Univer native JSON snapshots. No
    // overlap with the code editor's `.json` (we use `.univer`/`.usheet`/…).
    match: ["text/csv", ".csv", ".tsv", ".usheet", ".udoc", ".uslide", ".univer"],
    source: univerOfficeSource,
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
  {
    plugin: "code-editor",
    id: "code",
    title: "Code",
    // Specific code/config extensions only — markdown stays with the markdown
    // editor above, and these don't overlap with image/pdf matchers.
    match: [
      "application/javascript", "text/javascript", "application/json", "text/css",
      ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".jsonc",
      ".html", ".htm", ".css", ".scss", ".less", ".py", ".rb", ".go", ".rs",
      ".java", ".c", ".h", ".cpp", ".cc", ".hpp", ".cs", ".php", ".swift",
      ".kt", ".kts", ".sh", ".bash", ".zsh", ".sql", ".yaml", ".yml", ".toml",
      ".xml", ".ini", ".env", ".lua", ".r", ".pl", ".dockerfile", ".vue",
      ".svelte", ".graphql", ".proto",
    ],
    source: codeEditorSource,
  },
];

// Viewer plugins that also appear in the store are gated on install state;
// built-in viewers (image/pdf/markdown/univer — not in the catalog) are always
// available, so opening common file types never depends on an install step.
const STORE_GATED = new Set(PLUGIN_CATALOG.map((c) => c.id));

// Viewers from AI-generated (Plugin Studio) plugins, loaded at runtime from the
// API. Unlike the bundled VIEWERS these aren't known at build time, so the host
// registers them imperatively once the caller's custom plugins resolve. They're
// always install-gated (a generated viewer only applies when its plugin is in
// the active set) and take precedence over the bundled list so a user's own
// viewer can intentionally override a built-in for a file type.
let CUSTOM_VIEWERS: InstalledViewer[] = [];
const CUSTOM_IDS = new Set<string>();

/** Replace the runtime custom-viewer set (call when the caller's custom plugins load/change). */
export function setCustomViewers(viewers: InstalledViewer[]): void {
  CUSTOM_VIEWERS = viewers;
  CUSTOM_IDS.clear();
  for (const v of viewers) CUSTOM_IDS.add(v.plugin);
}

/**
 * First viewer whose `match` covers this file, or undefined.
 *
 * When `installedIds` is given, store-listed and generated viewers are only
 * offered if the plugin is in that set; an uninstalled match is skipped so
 * resolution falls through to the next matching (built-in) viewer, or to "no
 * viewer". Omit `installedIds` to resolve without gating.
 */
export function findViewer(name: string, mime?: string, installedIds?: string[]): InstalledViewer | undefined {
  const ext = name.split(".").pop();
  return [...CUSTOM_VIEWERS, ...VIEWERS].find((v) => {
    if (!viewerMatches(v.match, { mime, ext })) return false;
    const gated = STORE_GATED.has(v.plugin) || CUSTOM_IDS.has(v.plugin);
    if (installedIds && gated && !installedIds.includes(v.plugin)) return false;
    return true;
  });
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
  {
    plugin: "univer-office",
    id: "sheet",
    label: "Spreadsheet",
    icon: "table-2",
    defaultName: "Untitled",
    // A blank .csv opens in the Univer spreadsheet editor and saves back as CSV.
    extension: ".csv",
    mime: "text/csv",
    template: "",
  },
  {
    plugin: "univer-office",
    id: "doc",
    label: "Document",
    icon: "file-text",
    defaultName: "Untitled",
    // A minimal Univer IDocumentData snapshot (empty paragraph + section break);
    // opens in the Univer document editor and saves the JSON snapshot back.
    extension: ".udoc",
    mime: "application/json",
    template: JSON.stringify(
      {
        id: "doc",
        body: {
          dataStream: "\r\n",
          textRuns: [],
          paragraphs: [{ startIndex: 0 }],
          sectionBreaks: [{ startIndex: 1 }],
        },
        documentStyle: {
          pageSize: { width: 595, height: 842 },
          marginTop: 50,
          marginBottom: 50,
          marginLeft: 50,
          marginRight: 50,
        },
      },
      null,
      2,
    ),
  },
];
