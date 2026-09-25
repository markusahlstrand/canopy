/**
 * Reading one space's drive from the Substrat vertical instead of canopy's own API —
 * the first S12 slice (#64), behind a flag and off by default.
 *
 * ## What this is proving
 *
 * S12 decided the portal stays the product and its backend converges onto the
 * vertical, one operation class at a time, in S10's order: reads first. This is that
 * first read. Everything else in the portal still talks to `apps/api`.
 *
 * ## Why it can work at all
 *
 * Canopy serves its UI and API from one worker; so does the vertical. So this is a
 * cross-origin, credentialed request, and it needs three things to line up, none of
 * them code:
 *
 *  - the vertical must name this portal's origin in its `PORTAL_ORIGIN` setting, or
 *    the browser refuses the response;
 *  - the two hosts must be SAME-SITE (siblings under one registrable domain), because
 *    the vertical's session cookie is host-only and `SameSite=Lax` — a portal on an
 *    unrelated domain sends no cookie and every read comes back 401;
 *  - both must trust the SAME OIDC issuer, or signing in to the portal leaves the
 *    vertical signed out. Sharing a cookie shares a cookie, not an identity.
 *
 * ## What it deliberately does not do
 *
 * No mirror, no offline cache, no listing cache. Those are built on canopy's own
 * change feed and the vertical is not on it yet (S8). A flagged space is live-only,
 * which is honest for a slice whose point is "can the portal render scope-backed
 * data at all" — and the reason this is one function rather than a rewrite of
 * `listFiles`.
 */
import type { FileItem } from "@/lib/mock-data";
import { fmtDate, kindForName } from "@/lib/file-format";

/** The vertical's origin, e.g. `https://canopy.ahlstrand.es`. Unset ⇒ feature off. */
const BASE = (import.meta.env.VITE_DRIVE_VERTICAL_URL ?? "").replace(/\/+$/, "");

/** Which portal space this vertical backs. Unset ⇒ feature off. */
const SPACE = import.meta.env.VITE_DRIVE_VERTICAL_SPACE ?? "";

/**
 * The root folder's id, created with the schema rather than by a first write.
 * Mirrors `ROOT_FOLDER_ID` in `packages/scope-drive/src/migrations.ts`.
 */
const ROOT = "root";

/** Marks an id as belonging to the vertical's store rather than canopy's own. */
export const VERTICAL_ID_PREFIX = "vertical:";

/** The vertical's bytes route for one of its file ids, or null if this is not one. */
export function verticalContentUrl(id: string): string | null {
  if (!BASE || !id.startsWith(VERTICAL_ID_PREFIX)) return null;
  return `${BASE}/api/files/${encodeURIComponent(id.slice(VERTICAL_ID_PREFIX.length))}/content`;
}

export const verticalBacks = (spaceId?: string): boolean =>
  Boolean(BASE && SPACE && spaceId === SPACE);

interface DriveFolder {
  id: string;
  name: string;
  path: string;
}

interface DriveFile {
  id: string;
  name: string;
  updated_at: string;
}

/**
 * The next page's URL from an RFC 8288 `Link`, or null when the walk is over.
 *
 * Exported because it is the one piece of this file that can be wrong silently: a
 * parser that returns null too eagerly truncates a folder and looks like an empty
 * one. Follow the URL verbatim — it carries the request's page size and filters.
 */
export function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = /^\s*<([^>]+)>\s*;\s*(.+)$/.exec(part);
    // The quote is optional, so `next` must be anchored — an unanchored `"?next"?`
    // also matches `rel="nextish"`, which is a different relation.
    if (m && /\brel\s*=\s*(?:"next"|'next'|next(?![\w-]))/i.test(m[2]!)) return m[1]!;
  }
  return null;
}

/** Thrown when the vertical does not know this visitor. The caller can offer a sign-in. */
export class VerticalSignInRequired extends Error {
  readonly signInUrl: string;
  constructor(signInUrl: string) {
    super("sign in to this space");
    this.name = "VerticalSignInRequired";
    this.signInUrl = signInUrl;
  }
}

/**
 * Where to send someone who is signed in to the portal but not to the vertical.
 *
 * Two services, two sessions: `credentials: "include"` SENDS a cookie, it cannot
 * create one. Even with a shared issuer the visitor must complete the vertical's own
 * relying-party round trip once, after which the issuer's live session makes it
 * invisible. `returnTo` is a path on the VERTICAL, so it lands on its own origin;
 * coming back here is the browser's back button until the portal owns that flow.
 */
export const verticalSignInUrl = (): string => `${BASE}/api/auth/login`;

/**
 * Read one list endpoint to the END, following `Link` pages.
 *
 * A paged read answers a bare array and hides the walk in a header, and the platform's
 * default page is 20 — so the first response is the first 20 rows of a folder, not the
 * folder. Reading only it would silently drop the 21st file, which is the kind of wrong
 * that looks like a working feature.
 *
 * `limit=200` (the platform ceiling) to keep an ordinary folder to one round trip, and
 * a page cap so a server that kept answering with a next link could not spin here
 * forever.
 */
async function getAll<T>(path: string): Promise<T[]> {
  const sep = path.includes("?") ? "&" : "?";
  let url: string | null = `${BASE}/api${path}${sep}limit=200`;
  const rows: T[] = [];

  for (let page = 0; url && page < 50; page++) {
    const res: Response = await fetch(url, {
      // The whole point: send the vertical's own session cookie. Without this every
      // read is anonymous, which looks exactly like "the space is empty".
      credentials: "include",
      headers: { accept: "application/json" },
    });
    // 401 is not a failure of this request, it is the absence of a session HERE.
    if (res.status === 401) throw new VerticalSignInRequired(verticalSignInUrl());
    if (!res.ok) throw new Error(`vertical ${res.status}`);
    rows.push(...((await res.json()) as T[]));
    // Needs `Access-Control-Expose-Headers` on the vertical, or a browser hands us
    // null here and the walk stops after one page with no sign anything was missed.
    url = nextLink(res.headers.get("link"));
  }
  return rows;
}

/** A single (unpaged) read — `drive/folder-by-path` answers one row or null. */
async function getOne<T>(path: string): Promise<T | null> {
  const res = await fetch(`${BASE}/api${path}`, {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  if (res.status === 401) throw new VerticalSignInRequired(verticalSignInUrl());
  if (!res.ok) throw new Error(`vertical ${res.status}`);
  return (await res.json()) as T | null;
}

const join = (dir: string, name: string) => [dir, name].filter(Boolean).join("/");

/**
 * The folder id a portal path names. The root is known; anything deeper is one
 * lookup, because the portal addresses folders by path and the drive by id.
 */
async function folderIdFor(dir: string): Promise<string | null> {
  if (!dir) return ROOT;
  const folder = await getOne<DriveFolder>(`/folders/by-path?path=${encodeURIComponent(dir)}`);
  // Null covers both "no such folder" and "not yours" — the drive answers the same
  // either way, on purpose, so a path lookup cannot map a tree you cannot read.
  return folder?.id ?? null;
}

/**
 * One folder of a vertical-backed space, as the portal's file table renders it.
 *
 * Folders and files come from two reads because they are two entities; they are
 * merged here, folders first, which is the order the portal already uses.
 */
export async function listVerticalFolder(dir: string): Promise<FileItem[]> {
  const folderId = await folderIdFor(dir);
  if (!folderId) return [];

  const [folders, files] = await Promise.all([
    getAll<DriveFolder>(`/folders/${encodeURIComponent(folderId)}/folders`),
    getAll<DriveFile>(`/folders/${encodeURIComponent(folderId)}/files`),
  ]);

  const asFolders: FileItem[] = folders.map((f) => ({
    id: `folder:${join(dir, f.name)}`,
    name: f.name,
    kind: "folder",
    modified: "—",
    size: "—",
    path: join(dir, f.name),
  }));

  const asFiles: FileItem[] = files.map((f) => ({
    // NAMESPACED, the way a connector-backed id already is (`connector:<plugin>:<path>`).
    // A bare id would be handed to `/api/files/:id/content` on the PORTAL's origin,
    // which resolves ids in canopy's own store — a different store, where this id means
    // nothing. Prefixing makes every other action fail loudly on an unknown id rather
    // than quietly addressing the wrong drive.
    id: `${VERTICAL_ID_PREFIX}${f.id}`,
    name: f.name,
    kind: kindForName(f.name),
    modified: fmtDate(f.updated_at),
    // The drive keeps a size on the VERSION, not the file row, and this read does not
    // fetch versions. An em dash says "not asked", which is true; a 0 would not be.
    size: "—",
    path: dir,
  }));

  return [...asFolders, ...asFiles];
}
