/**
 * The vertical's own API, as the browser sees it.
 *
 * Every path here is derived from an operation declared in
 * `packages/scope-drive/spec/model.ts` — `mountOperations` builds the routes from
 * the same `http` block, so a path that drifts here is a path that drifts from
 * the declaration. Kept in ONE small file deliberately: the drive's write path is
 * being split into ensure-file → put bytes → record-version, so this is the file
 * that changes when it lands, and nothing else is.
 *
 * No generated client yet. The demos in the substrat repo generate one from the
 * operation table (`substrat.client` in package.json); that is the right end
 * state here too, and this hand-written seam is the shape it would replace.
 */

/** Every derived route sits under `/api` — `mountOperations`' default base path. */
const API = '/api';

/**
 * The root folder's id, created with the schema rather than by a first write, so
 * a fresh scope always has somewhere to read. Mirrors `ROOT_FOLDER_ID` in
 * `packages/scope-drive/src/migrations.ts`.
 */
export const ROOT_FOLDER_ID = 'root';

export interface DriveFile {
  id: string;
  folder_id: string;
  name: string;
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface DriveFolder {
  id: string;
  parent_id: string;
  name: string;
  path: string;
}

export interface FileVersion {
  id: string;
  file_id: string;
  size: number | null;
  created_at: string;
}

/**
 * A failed call, carrying the status so a caller can tell "nobody is signed in"
 * from "this went wrong" without parsing prose. 401 is not an error condition in
 * this app — it is the logged-out state — so it has to stay distinguishable.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    // The session is a cookie the worker set on /api/auth/callback; without this
    // every call is anonymous and the app renders a permanent logged-out state.
    credentials: 'same-origin',
    headers: init?.body ? { 'content-type': 'application/json', ...init?.headers } : init?.headers,
  });
  if (!res.ok) {
    // The platform answers errors as RFC 9457 problem documents; fall back to the
    // status line for anything that is not one (a proxy, a cold start).
    const problem = await res.json().catch(() => null);
    const detail =
      problem && typeof problem === 'object' && 'detail' in problem
        ? String((problem as { detail: unknown }).detail)
        : res.statusText;
    throw new ApiError(res.status, detail);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** Who am I — the first call the app makes, and the one that decides which shell renders. */
export const whoami = () => call<{ principal: string }>('/me');

/**
 * The files directly inside a folder.
 *
 * A paged read's BODY is a bare array — the walk rides in a `Link` header, which
 * is why this is not `{ entries: [...] }`. One page is enough to render, and the
 * header is where the next one would come from when this grows a "load more".
 */
export const listFolder = (folderId: string) =>
  call<DriveFile[]>(`/folders/${encodeURIComponent(folderId)}/files`);

export const createFolder = (parentId: string, name: string) =>
  call<DriveFolder>(`/folders/${encodeURIComponent(parentId)}/folders`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });

/** Create the file row, or return the one already at this (folder, name). */
export const ensureFile = (folderId: string, name: string) =>
  call<DriveFile>(`/folders/${encodeURIComponent(folderId)}/files`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });

/** A file's versions, newest first. Paged, so again a bare array. */
export const fileVersions = (fileId: string) =>
  call<FileVersion[]>(`/files/${encodeURIComponent(fileId)}/versions`);

/** The relying-party routes the worker mounts. Full page loads: the issuer owns the redirect. */
export const LOGIN_URL = `${API}/auth/login`;
export const LOGOUT_URL = `${API}/auth/logout`;
