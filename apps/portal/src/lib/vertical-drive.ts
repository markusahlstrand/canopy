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

/** A paged read answers a bare array; the walk rides a `Link` header we do not follow yet. */
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    // The whole point: send the vertical's own session cookie. Without this every
    // read is anonymous, which looks exactly like "the space is empty".
    credentials: "include",
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`vertical ${res.status}`);
  return (await res.json()) as T;
}

const join = (dir: string, name: string) => [dir, name].filter(Boolean).join("/");

/**
 * The folder id a portal path names. The root is known; anything deeper is one
 * lookup, because the portal addresses folders by path and the drive by id.
 */
async function folderIdFor(dir: string): Promise<string | null> {
  if (!dir) return ROOT;
  const folder = await get<DriveFolder | null>(`/folders/by-path?path=${encodeURIComponent(dir)}`);
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
    get<DriveFolder[]>(`/folders/${encodeURIComponent(folderId)}/folders`),
    get<DriveFile[]>(`/folders/${encodeURIComponent(folderId)}/files`),
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
    id: f.id,
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
