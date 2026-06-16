import { viewerMatches, type FileCreatorContribution, type ViewerContribution } from "@canopy/core";
import { BUNDLED_PLUGINS } from "./bundled";

/** A viewer the host can mount: a contribution plus the code that implements it. */
export interface InstalledViewer extends ViewerContribution {
  /** Owning plugin id. */
  plugin: string;
  /** ESM entry source handed to the sandbox. */
  source: string;
}

/**
 * Viewers available to the preview surface, derived from each bundled plugin's
 * `contributes.viewers` — the manifest is the single source of truth for which
 * file types a plugin handles. (Plugin Studio / third-party viewers come in
 * through {@link setCustomViewers} at runtime; same shape, different origin.)
 */
export const VIEWERS: InstalledViewer[] = BUNDLED_PLUGINS.flatMap(({ manifest, source }) =>
  (manifest.contributes?.viewers ?? []).map((v) => ({ ...v, plugin: manifest.id, source })),
);

// Viewers from AI-generated (Plugin Studio) plugins, loaded at runtime from the
// API. Unlike the bundled VIEWERS these aren't known at build time, so the host
// registers them imperatively once the caller's custom plugins resolve. They
// take precedence over the bundled list so a user's own viewer can intentionally
// override a built-in for a file type.
let CUSTOM_VIEWERS: InstalledViewer[] = [];

/** Replace the runtime custom-viewer set (call when the caller's custom plugins load/change). */
export function setCustomViewers(viewers: InstalledViewer[]): void {
  CUSTOM_VIEWERS = viewers;
}

/**
 * First viewer whose `match` covers this file, or undefined.
 *
 * Every viewer belongs to an installable plugin, so when `installedIds` is given
 * a match is only offered if its plugin is installed; an uninstalled match is
 * skipped so resolution falls through to the next matching viewer, or to "no
 * viewer". Omit `installedIds` to resolve without gating. The baseline viewers
 * (image/pdf/markdown) ship installed by default, so common types preview out of
 * the box.
 */
export function findViewer(name: string, mime?: string, installedIds?: string[]): InstalledViewer | undefined {
  const candidates = [...CUSTOM_VIEWERS, ...VIEWERS].filter((v) => !installedIds || installedIds.includes(v.plugin));
  // A multi-part suffix pattern (e.g. `.arazzo.yaml`) is more specific than a bare
  // extension, so it wins over a generic viewer that also claims `.yaml`.
  // `viewerMatches` only sees the final extension, so check these against the whole
  // name here, before falling back to extension/MIME matching.
  const lname = name.toLowerCase();
  const specific = candidates.find((v) =>
    v.match.some((raw) => {
      const pat = raw.toLowerCase().trim();
      return pat.startsWith(".") && pat.indexOf(".", 1) > 0 && lname.endsWith(pat);
    }),
  );
  if (specific) return specific;
  const ext = name.split(".").pop();
  return candidates.find((v) => viewerMatches(v.match, { mime, ext }));
}

/** A new-file type the host's "New" menu can offer: a contribution + its owning plugin. */
export interface InstalledCreator extends FileCreatorContribution {
  /** Owning plugin id. */
  plugin: string;
}

/**
 * File types offerable from the "New" menu, built from each bundled plugin's
 * `contributes.creators`. Mirrors {@link VIEWERS}: declared once in the manifest,
 * surfaced here.
 */
export const CREATORS: InstalledCreator[] = BUNDLED_PLUGINS.flatMap(({ manifest }) =>
  (manifest.contributes?.creators ?? []).map((c) => ({ ...c, plugin: manifest.id })),
);

/** Creators from installed plugins only — the "New" menu shouldn't offer a file
 * type whose viewer plugin isn't installed (you'd create something you can't open). */
export function creatorsFor(installedIds: string[]): InstalledCreator[] {
  return CREATORS.filter((c) => installedIds.includes(c.plugin));
}
