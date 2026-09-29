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
 * Which space this tab is looking at, as a slug the install's own registry knows.
 *
 * It rides as `x-site` on every call rather than living in the URL. The worker takes
 * the TENANT from the router's assertion and never from a header, and re-checks the
 * (tenant, scope) pair, so the worst a tampered value can name is another space of the
 * same tenant — which the checker then refuses unless the caller holds a role there.
 *
 * `null` means "whatever the hostname routed to", which is the right default: a person
 * with one space should never see a switcher decide anything.
 */
let site: string | null = null;
const SITE_KEY = 'canopy.site';
try {
  site = localStorage.getItem(SITE_KEY);
} catch {
  // Private mode, blocked site data: the hostname's own space is the fallback.
}

export const currentSite = (): string | null => site;

export function selectSite(slug: string | null): void {
  site = slug;
  try {
    if (slug) localStorage.setItem(SITE_KEY, slug);
    else localStorage.removeItem(SITE_KEY);
  } catch {
    // Selection still applies to this tab; it just will not survive a reload.
  }
}

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

export interface Site {
  slug: string;
  name: string;
}

export interface FileVersion {
  id: string;
  file_id: string;
  source: string;
  blob_ref: string | null;
  mime: string;
  size: number | null;
  created_at: string;
}

/**
 * The file's bytes as text, bounded.
 *
 * Only for a type the browser would show as text anyway. The bound is not politeness:
 * this lands in a React state and then in the DOM, and a 40MB log rendered into a `<pre>`
 * is a hung tab. What is cut says so rather than trailing off silently.
 */
export const TEXT_PREVIEW_LIMIT = 200_000;

export async function fileBodyAsText(fileId: string): Promise<{ text: string; truncated: boolean }> {
  const res = await fetch(contentUrl(fileId), { credentials: 'same-origin' });
  if (!res.ok) throw new ApiError(res.status, res.statusText);

  // Read as a STREAM and stop at the limit. `res.text()` would download and decode the
  // whole file first and then throw most of it away — so a 2GB log is 2GB through the
  // tab's memory to show its first 200k characters, which is the opposite of a bound.
  if (!res.body) {
    // No stream to read: a runtime or a test double that only implements `text()`.
    const whole = await res.text();
    return whole.length > TEXT_PREVIEW_LIMIT
      ? { text: whole.slice(0, TEXT_PREVIEW_LIMIT), truncated: true }
      : { text: whole, truncated: false };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length >= TEXT_PREVIEW_LIMIT) {
      truncated = true;
      // Cancel rather than break: the rest of the body should never leave the server.
      await reader.cancel();
      break;
    }
  }
  if (!truncated) text += decoder.decode();
  return { text: text.slice(0, TEXT_PREVIEW_LIMIT), truncated };
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

export function siteHeaders(extra?: HeadersInit): HeadersInit {
  return { ...(site ? { 'x-site': site } : {}), ...extra };
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    // The session is a cookie the worker set on /api/auth/callback; without this
    // every call is anonymous and the app renders a permanent logged-out state.
    credentials: 'same-origin',
    headers: siteHeaders(
      init?.body ? { 'content-type': 'application/json', ...init?.headers } : init?.headers,
    ),
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

/**
 * Who am I, in the shape the shell reads.
 *
 * `user` is null when nobody is signed in, which is a state rather than an error: the
 * worker answers 401 for an unauthenticated caller and the shell renders its signed-out
 * form. The portal's `Me` carried plan and quota fields this install has no source for.
 */
export interface Me {
  user: { name?: string; email?: string } | null;
  principal?: string;
}

/** Who am I — the first call the app makes, and the one that decides which shell renders. */
export const whoami = () => call<{ principal: string }>('/me');

/**
 * Redeem an owner-claim link. The token arrives in the URL as `?claim=` (the platform
 * mints the link, the dashboard hands it over) and leaves in a POST body — a credential
 * in a query string lands in logs, history and the `Referer` of everything the page
 * loads next, and this one is live until it is consumed.
 *
 * Requires a session: the claim binds whoever is signed in to the seat it opens.
 */
export const claimOwner = (token: string) =>
  call<{ principal: string }>('/claim-owner', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });

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

/** One file and the version it currently points at — what a preview resolves through. */
export const getFile = (fileId: string) =>
  call<{ file: DriveFile; version: FileVersion | null }>(`/files/${encodeURIComponent(fileId)}`);

/**
 * What extraction found, or `null` for "nobody has looked".
 *
 * The text itself is not here: the operation omits it, because the row is what a screen
 * needs and the body is what the FTS index is for. `status` carries the useful
 * distinction — `empty` is "we looked and there was nothing", which is a different
 * sentence to `unsupported` and a very different one to `null`.
 */
export const fileText = (fileId: string) =>
  call<FileTextRow | null>(`/files/${encodeURIComponent(fileId)}/text`);

export interface FileTextRow {
  id: string;
  file_id: string;
  version_id: string;
  status: 'indexed' | 'empty' | 'unsupported' | 'failed';
  chars: number;
  extracted_at: string | null;
  detail: string | null;
}

/** A file's versions, newest first. Paged, so again a bare array. */
export const fileVersions = (fileId: string) =>
  call<FileVersion[]>(`/files/${encodeURIComponent(fileId)}/versions`);

/** The spaces this login is bound in — empty when the install has only the routed one. */
export const listSites = () => call<Site[]>('/sites');

/** The folders directly inside a folder. Paged, so a bare array like the file listing. */
export const listFolders = (folderId: string) =>
  call<DriveFolder[]>(`/folders/${encodeURIComponent(folderId)}/folders`);

/**
 * A folder by its path, or null. `null` is also the answer for a folder the caller may
 * not read — the worker refuses indistinguishably on purpose, so a path cannot be used
 * to probe the tree one guess at a time.
 */
export const folderByPath = (path: string) =>
  call<DriveFolder | null>(`/folders/by-path?path=${encodeURIComponent(path)}`);

export const renameFile = (fileId: string, name: string) =>
  call<DriveFile>(`/files/${encodeURIComponent(fileId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });

export const renameFolder = (folderId: string, name: string) =>
  call<DriveFolder>(`/folders/${encodeURIComponent(folderId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });

/**
 * Move a file or a folder. Access follows: a grant above the destination reaches it
 * afterwards, and one above where it left does not (#75).
 */
export const moveFile = (fileId: string, folderId: string) =>
  call<DriveFile>(`/files/${encodeURIComponent(fileId)}/move`, {
    method: 'POST',
    body: JSON.stringify({ folderId }),
  });

export const moveFolder = (folderId: string, parentId: string) =>
  call<DriveFolder>(`/folders/${encodeURIComponent(folderId)}/move`, {
    method: 'POST',
    body: JSON.stringify({ parentId }),
  });

/** Recoverable: the bytes stay, and `restoreFile` puts it back under the same name. */
export const trashFile = (fileId: string) =>
  call<DriveFile>(`/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });

export const restoreFile = (fileId: string) =>
  call<DriveFile>(`/files/${encodeURIComponent(fileId)}/restore`, { method: 'POST' });

/**
 * Find files by name or by what is inside them.
 *
 * `via` is the half that content extraction bought: a hit that matched the document's
 * text reads differently to one that matched its name, and a result list that hides the
 * difference is back to being a filename search with extra steps.
 *
 * The term has a two-character floor in the declaration, so a caller below it is a 400
 * rather than a scan of the whole index — the screen holds its request until then.
 */
export const SEARCH_MIN = 2;

export const search = (term: string, limit?: number) =>
  call<{ hits: SearchHit[] }>(
    `/search?term=${encodeURIComponent(term)}${limit ? `&limit=${limit}` : ''}`,
  );

export interface SearchHit extends DriveFile {
  via: 'name' | 'content';
}

/** What is in the trash, scope-wide — a trashed file's folder is where it goes back to. */
export const listTrash = () => call<DriveFile[]>('/trash');

/**
 * Upload bytes and record the version that names them, in one call the worker
 * composes: ensure-file → attachment upload → record-version. The size and type the
 * version records come from the stored bytes, not from anything said here.
 */
export async function uploadFile(folderId: string, file: File): Promise<DriveFile> {
  const res = await fetch(
    `${API}/folders/${encodeURIComponent(folderId)}/content?name=${encodeURIComponent(file.name)}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: siteHeaders({ 'content-type': file.type || 'application/octet-stream' }),
      body: file,
    },
  );
  if (!res.ok) {
    const problem = await res.json().catch(() => null);
    const detail =
      problem && typeof problem === 'object' && 'detail' in problem
        ? String((problem as { detail: unknown }).detail)
        : res.statusText;
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as DriveFile;
}

/**
 * Where a file's bytes are, as a URL the browser can follow directly.
 *
 * A plain link, so the browser streams it rather than the app buffering it — which
 * also means the `x-site` header cannot ride along. The query parameter is the same
 * selection said in the one place a link can carry it.
 */
export function contentUrl(fileId: string): string {
  const q = site ? `?site=${encodeURIComponent(site)}` : '';
  return `${API}/files/${encodeURIComponent(fileId)}/content${q}`;
}

/** The relying-party routes the worker mounts. Full page loads: the issuer owns the redirect. */
export const LOGIN_URL = `${API}/auth/login`;
export const LOGOUT_URL = `${API}/auth/logout`;
