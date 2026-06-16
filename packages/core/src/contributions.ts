/**
 * Declarative UI contribution points. A plugin describes what it adds to the
 * host UI via its manifest; the host renders the slots. Plugins do NOT ship
 * arbitrary client JS in v1 — these descriptors are the surface.
 */

import type { ConnectorConfigField } from "./storage";

export interface ContextMenuContribution {
  id: string;
  label: string;
  /** lucide icon name. */
  icon?: string;
  /** Restrict to item kinds (e.g. ["pdf","image"]); omit = all items. */
  when?: { kinds?: string[] };
}

/** A panel the plugin renders into the right-hand rail. */
export interface RailPanelContribution {
  id: string;
  title: string;
  icon?: string;
}

/** A full-content view shown when the plugin is opened from the sidebar. */
export interface DetailViewContribution {
  id: string;
  title: string;
  /**
   * Place a launcher for this view in the left sidebar, under a section heading
   * the plugin names (e.g. "Games", "Tools"). This is what makes a plugin a
   * standalone *app* — reachable on its own, not only when a matching file opens.
   * Omit to keep the detail view reachable from Home / the plugin list only.
   */
  nav?: { section: string };
  /**
   * Render this view edge-to-edge: the host drops its page header/chrome and the
   * centred max-width column, letting a canvas-style app own the whole content
   * area. Omit for the standard padded, headed page used by most app plugins.
   */
  immersive?: boolean;
}

/** A field the plugin adds to the file preview details grid. */
export interface DetailFieldContribution {
  id: string;
  label: string;
}

/**
 * Declares a file type the plugin can create from the host's "New" menu. The
 * host renders one menu entry per creator; choosing it creates a new file in the
 * current folder (seeded with `template`, if any) and opens it — typically in the
 * same plugin's viewer/editor, since the plugin that authors a `.md` also views it.
 */
export interface FileCreatorContribution {
  id: string;
  /** Menu label, e.g. "Markdown document". */
  label: string;
  /** lucide icon name for the menu entry. */
  icon?: string;
  /** Default base name (without extension) for the new file, e.g. "Untitled". */
  defaultName: string;
  /** Extension appended to the name, including the dot, e.g. ".md". */
  extension: string;
  /** MIME type stored on the file's first version. */
  mime?: string;
  /** Optional starter content for the new file (UTF-8 text). */
  template?: string;
}

/**
 * A sandboxed viewer the plugin renders for matching file types. The host loads
 * the plugin's viewer code into an isolated, opaque-origin iframe and hands it
 * only the previewed file's bytes — never host DOM, cookies, or storage. See
 * the runtime-agnostic protocol in the host's plugin-viewer surface.
 */
export interface ViewerContribution {
  id: string;
  /** Label shown on the preview surface (e.g. "PDF", "Image"). */
  title?: string;
  /**
   * MIME types and/or file extensions this viewer handles. Each entry is one of:
   * an exact MIME (`"application/pdf"`), a MIME wildcard (`"image/*"`), a
   * dot-extension (`".heic"`), or a bare extension (`"pdf"`). Matched against the
   * previewed file's MIME and extension.
   */
  match: string[];
  /**
   * Fill the available preview box instead of auto-growing the viewer to its
   * content. For media/canvas viewers (an image, a model canvas) that should
   * occupy a real box the host sizes, rather than a document that flows.
   */
  fill?: boolean;
  /**
   * When expanded full screen, take over the whole surface: the host hides the
   * metadata sidebar, the prev/next nav arrows and the centred max-width cap, and
   * yields the arrow keys to the viewer. For immersive editor/canvas viewers.
   */
  immersive?: boolean;
}

/** How the plugin appears in the plugin store. */
export interface StoreListing {
  category: "Productivity" | "Finance" | "Lifestyle" | "Security" | "Media" | "Wellness" | "Help";
  tagline: string;
  popular?: boolean;
}

/**
 * Declares that the plugin contributes one or more typed data sources (a server
 * adapter implementing TaskProvider / CalendarProvider). Installing such a plugin
 * connects its data into the matching host plugins (tasks, calendar). The actual
 * provider factory is registered host-side, keyed by plugin id — this descriptor
 * is just what the plugin advertises.
 */
export interface DataSourceContribution {
  /** Which host surfaces this plugin can feed. */
  provides: ("tasks" | "calendar")[];
  /** Config the source needs to connect (e.g. a repo). */
  config?: ConnectorConfigField[];
}

export interface Contributions {
  contextMenu?: ContextMenuContribution[];
  railPanel?: RailPanelContribution;
  detailView?: DetailViewContribution;
  detailFields?: DetailFieldContribution[];
  viewers?: ViewerContribution[];
  creators?: FileCreatorContribution[];
  store?: StoreListing;
  dataSource?: DataSourceContribution;
}

/**
 * Pure matcher: does a viewer's `match` list cover this file? Shared by the host
 * preview surface and any server-side resolution. `ext` may include or omit the
 * leading dot. Comparison is case-insensitive.
 */
export function viewerMatches(match: string[], file: { mime?: string; ext?: string }): boolean {
  const mime = file.mime?.toLowerCase().split(";")[0]?.trim();
  const ext = file.ext?.toLowerCase().replace(/^\./, "");
  return match.some((raw) => {
    const pat = raw.toLowerCase().trim();
    if (pat.startsWith(".")) return !!ext && ext === pat.slice(1);
    if (pat.endsWith("/*")) return !!mime && mime.startsWith(pat.slice(0, -1));
    if (pat.includes("/")) return !!mime && mime === pat;
    return !!ext && ext === pat; // bare extension, e.g. "pdf"
  });
}
