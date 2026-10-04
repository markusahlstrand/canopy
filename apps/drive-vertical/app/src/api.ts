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

/**
 * The URL wins over the stored selection.
 *
 * `?site=` is how a selection survives a reload when storage refused to hold it (see
 * `selectSite`), so it has to outrank the stale value storage may still have. It is also
 * the more explicit of the two: a link someone followed, against a preference from
 * whenever.
 */
try {
  site = new URL(window.location.href).searchParams.get('site');
} catch {
  // No URL to read: a non-browser runtime loading this module.
}
if (!site) {
  try {
    site = localStorage.getItem(SITE_KEY);
  } catch {
    // Private mode, blocked site data: the hostname's own space is the fallback.
  }
}

export const currentSite = (): string | null => site;

/**
 * Select a space, and say whether the choice will survive a reload.
 *
 * `false` means storage refused us. The caller has to carry the slug some other way,
 * because a selection that only exists in this module's memory is gone the moment the
 * page reloads — and reloading is how a space change takes effect.
 */
export function selectSite(slug: string | null): boolean {
  site = slug;
  try {
    if (slug) localStorage.setItem(SITE_KEY, slug);
    else localStorage.removeItem(SITE_KEY);
    return true;
  } catch {
    // Selection still applies to this tab; it just will not survive a reload.
    return false;
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

/** A metadata invalidation from the scope's event spine, hydrated to current state. */
export type DriveChange =
  | { id: string; type: string; entityType: 'file'; entityId: string; file: DriveFile | null }
  | { id: string; type: string; entityType: 'folder'; entityId: string; folder: DriveFolder | null };

export interface DriveChanges {
  changes: DriveChange[];
  /** Exclusive event-id cursor; null before the first event. */
  cursor: string | null;
  hasMore: boolean;
}

export const changes = (after: string | null, limit = 100) =>
  call<DriveChanges>(`/changes?limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ''}`);

export interface Site {
  icon?: string; color?: string;
  slug: string;
  name: string;
  /**
   * This is the space the request was answered in.
   *
   * The server decides it, because the client cannot: with no selection the space comes
   * from the hostname the router resolved, and only the worker can say which slug that
   * was. A selection makes it follow the selection.
   */
  current: boolean;
}

export interface FileVersion {
  keep: number;
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

/**
 * The most text a save may carry, in UTF-16 code units (`string.length`). It mirrors
 * `MAX_EDIT_CHARS` in `src/text-content.ts`, which refuses `text.length` above it, so
 * the editor must count the same unit: UTF-8 bytes would refuse non-Latin text the
 * server accepts.
 */
export const TEXT_EDIT_LIMIT = 200_000;

export class TextEncodingError extends Error {
  constructor() { super('This version is not UTF-8 text. Download it to view its contents.'); this.name = 'TextEncodingError'; }
}

export async function fileBodyAsText(fileId: string, versionId?: string): Promise<{ text: string; truncated: boolean }> {
  const res = await fetch(versionId ? versionContentUrl(fileId, versionId) : contentUrl(fileId), { credentials: 'same-origin' });
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
  const decoder = new TextDecoder('utf-8', { fatal: !!versionId });
  const decode = (bytes?: Uint8Array, options?: TextDecodeOptions) => {
    try { return decoder.decode(bytes, options); } catch { throw new TextEncodingError(); }
  };
  let text = '';
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decode(value, { stream: true });
      if (text.length >= TEXT_PREVIEW_LIMIT) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
    if (!truncated) text += decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }

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

export function siteHeaders(extra?: HeadersInit, selectedSite = site): HeadersInit {
  return { ...(selectedSite ? { 'x-site': selectedSite } : {}), ...extra };
}

async function request(path: string, init?: RequestInit, selectedSite = site): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    // The session is a cookie the worker set on /api/auth/callback; without this
    // every call is anonymous and the app renders a permanent logged-out state.
    credentials: 'same-origin',
    headers: siteHeaders(
      init?.body ? { 'content-type': 'application/json', ...init?.headers } : init?.headers,
      selectedSite,
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
  return res;
}

async function call<T>(path: string, init?: RequestInit, selectedSite = site): Promise<T> {
  const res = await request(path, init, selectedSite);
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
 * An open invitation, as the directory records it.
 *
 * `principal` is pre-minted and already holds its role, so it is the id a revoke names —
 * the person it is for may not exist yet, and `email` is a note on the invitation rather
 * than an address the platform has verified.
 */
export interface Invite {
  principal: string;
  roleKey: string;
  email: string | null;
  createdAt?: string;
}

/**
 * A person this install has seen in this space.
 *
 * `principal` is what a grant names; the rest is what a human recognises. Both nullable,
 * because an issuer need not release either claim — a row with neither is a principal and
 * nothing more, which the UI has to render as such rather than as a blank.
 */
export interface Person {
  principal: string;
  email: string | null;
  name: string | null;
  seen_at: string;
}

/**
 * The people seen in this space — a projection of sign-ins, NOT the roster of record.
 *
 * Membership is a role the kernel holds; this is only what to call someone. A member who
 * has never signed in here is absent while still being a member, so nothing may present
 * this as everyone.
 */
export const listPeople = () => call<{ people: Person[] }>('/people');

/**
 * A share as the drive recorded it, with the roster's name joined on.
 *
 * `permission` is a kernel key, one row per key — so somebody who may edit AND share a
 * folder is two rows. `sharesByPerson` below is what turns that into something to render.
 */
export interface Share {
  folder_id: string;
  principal: string;
  permission: string;
  granted_at: string;
  granted_by: string;
  email: string | null;
  name: string | null;
}

/**
 * What a person can do with a shared folder, as a UI offers it.
 *
 * The kernel's three keys are INDEPENDENT — `drive:manage` is the authority to share a
 * folder and delete what is in it, and does not include putting anything in it. The ladder
 * canopy came from was nested (viewer ⊂ editor ⊂ owner), so the two have to be mapped
 * rather than assumed equal: "can edit and share" is two grants, and this is where that
 * fact is turned into one choice instead of being left to whoever writes the dialog.
 */
export type ShareLevel = 'edit' | 'manage';

const LEVEL_KEYS: Record<ShareLevel, string[]> = {
  edit: ['drive:write'],
  manage: ['drive:write', 'drive:manage'],
};

/** One row per person, with the level their keys add up to. */
export interface PersonShare {
  principal: string;
  email: string | null;
  name: string | null;
  level: ShareLevel;
}

export function sharesByPerson(shares: Share[]): PersonShare[] {
  const byPrincipal = new Map<string, PersonShare>();
  for (const share of shares) {
    const seen = byPrincipal.get(share.principal);
    // Manage wins: it is the higher of the two offered levels, so a person holding both
    // keys reads as the level that includes them.
    const level: ShareLevel =
      share.permission === 'drive:manage' || seen?.level === 'manage' ? 'manage' : 'edit';
    byPrincipal.set(share.principal, {
      principal: share.principal,
      email: share.email,
      name: share.name,
      level,
    });
  }
  return [...byPrincipal.values()];
}

/** Who this folder is shared with — the drive's own record, not the kernel's. */
export const listFolderShares = (folderId: string) =>
  call<{ shares: Share[] }>(`/folders/${encodeURIComponent(folderId)}/shares`);

/**
 * Share a folder with somebody who is not in the space yet: invite, then grant.
 *
 * The portal could share with an address it had never seen — its grants took an `email`
 * subject, resolved server-side later. A grant here names a PRINCIPAL, so the equivalent is
 * two steps: an invitation pre-mints a principal (holding the member role, bindable when they
 * accept), and the share goes to that principal. They get one link; opening it makes them a
 * member, and the folder is already theirs to edit.
 *
 * Returns the accept link, because that link IS the invitation — nothing is emailed.
 *
 * A share that fails after the invitation was made is UNDONE, not left for a retry to pile on.
 * By then the seat holds the member role and maybe the first of the level's two keys; a
 * failure reported over a live invitation would leave both standing, and trying again would
 * mint a second seat beside it. So the invitation is revoked first — that alone makes the seat
 * unreachable, since nobody can bind to a principal whose invitation is gone — and then the
 * seat is removed like any person, which takes the role and whatever grants landed. Both are
 * idempotent. If the undo fails too, the error says what is still open and where to close it.
 */
export async function shareFolderWithEmail(folderId: string, email: string, level: ShareLevel) {
  const invited = await createInvite(MEMBER_ROLE_FALLBACK, email);
  try {
    await shareFolder(folderId, invited.principal, level);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    try {
      await revokeInvite(invited.principal);
    } catch {
      throw new Error(
        `${reason} — and the invitation for ${email} could not be withdrawn. Revoke it from People.`,
      );
    }
    // Tidying only: with the invitation gone, what is left of the seat is held by nobody.
    await removePerson(invited.principal).catch(() => undefined);
    throw new Error(`${reason} — nothing was shared and ${email} was not invited.`);
  }
  return { acceptUrl: invited.acceptUrl, principal: invited.principal, email };
}

/**
 * The role an invitation made from the share dialog carries.
 *
 * The People dialog reads the roles the server allows and uses what comes back; this path has
 * no list in hand and one role is all the worker offers (see `MEMBER_ROLE_KEY` there for why
 * that is a safety property). A wrong key is a 400 from the route rather than a silent
 * mis-grant, which is the right failure for a constant that drifts.
 */
const MEMBER_ROLE_FALLBACK = 'member';

/**
 * Share a folder at a level, which is one call per key the level carries.
 *
 * Sequential, and not `Promise.all`: two grants on one folder, and a failure halfway leaves
 * the person with the first key rather than with a half-applied pair nobody can reason
 * about. The keys are applied in order, so the weaker one lands first.
 */
export async function shareFolder(folderId: string, principal: string, level: ShareLevel) {
  for (const permission of LEVEL_KEYS[level]) {
    await call<Share>(`/folders/${encodeURIComponent(folderId)}/shares`, {
      method: 'POST',
      body: JSON.stringify({ principal, permission }),
    });
  }
}

/**
 * Withdraw access — by default all of it, or exactly the keys named.
 *
 * Withdrawing a key nobody holds is not an error (the operation answers rather than
 * refusing), so "Remove" does not need to know which keys somebody had.
 *
 * The named form exists for LOWERING a level, and the reason is worth stating: taking
 * everything away and granting the lower level back is two operations where the second can
 * fail — a network error, or a sharer who holds `drive:manage` but not `drive:write`, whom
 * `ctx.grant` would refuse. Either way the person ends with nothing when the intent was to
 * leave them editing. Removing only the surplus key cannot fail that way, because there is
 * nothing to put back.
 */
export async function unshareFolder(
  folderId: string,
  principal: string,
  permissions: readonly string[] = ['drive:manage', 'drive:write'],
) {
  for (const permission of permissions) {
    await call<unknown>(`/folders/${encodeURIComponent(folderId)}/shares`, {
      method: 'DELETE',
      body: JSON.stringify({ principal, permission }),
    });
  }
}

/**
 * Remove somebody from this space: their folder grants, their role, their binding.
 *
 * A worker route rather than a derived one, because only the worker can do all three — the
 * drive owns the grants and the platform owns the rest, and doing one alone leaves a member
 * who still reads everything. Refuses removing yourself: somebody has to be left who can
 * administer the space.
 */
export const removePerson = (principal: string) =>
  call<{ principal: string; revoked: number; unbound: number }>(
    `/people/${encodeURIComponent(principal)}`,
    { method: 'DELETE' },
  );

/** Whether this login administers the people in this space — `drive/people-access`. */
export const peopleAccess = () => call<{ canManage: boolean }>('/people/access');

/** The open invitations, and the roles a teammate may be invited at. Owner only. */
export const listInvites = () => call<{ roles: string[]; invites: Invite[] }>('/invites');

/**
 * Invite someone, at a role. Owner only.
 *
 * The answer carries `acceptUrl`, which is the whole product of this call: the invitation
 * IS that link. Nothing is emailed — the platform verifies no address here, so the link
 * is handed to whoever is inviting and they pass it on.
 */
export const createInvite = (roleKey: string, email?: string) =>
  call<{ principal: string; roleKey: string; email: string | null; acceptUrl: string }>('/invites', {
    method: 'POST',
    body: JSON.stringify(email ? { roleKey, email } : { roleKey }),
  });

/** Withdraw an invitation. The pre-minted principal loses its role with the row. */
export const revokeInvite = (principal: string) =>
  call<void>(`/invites/${encodeURIComponent(principal)}/revoke`, { method: 'POST' });

/**
 * Accept an invitation — the same shape as `claimOwner` and for the same reasons.
 *
 * The token arrives as `?invite=` and leaves in a POST body: a live credential in a query
 * string lands in history, logs and the `Referer` of everything the page loads next.
 * Requires a session, because accepting binds whoever is signed in to the invited seat.
 */
export const acceptInvite = (token: string) =>
  call<{ ok: true; principal: string }>('/accept-invite', {
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
  call<{ file: DriveFile; version: FileVersion | null; canWrite: boolean }>(`/files/${encodeURIComponent(fileId)}`);

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

export interface FileComment {
  id: string; file_id: string; author: string; body: string; created_at: string;
  deleted_at: string | null; authorLabel: string; canDelete: boolean;
}
export const commentPage = (fileId: string, next: string | null = null) => readPage<FileComment>(`/files/${encodeURIComponent(fileId)}/comments`, next);
export const postComment = (fileId: string, body: string) => call<FileComment>(`/files/${encodeURIComponent(fileId)}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
export const deleteComment = (fileId: string, commentId: string) => call(`/files/${encodeURIComponent(fileId)}/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' });

export interface FileDetails {
  fileId: string; description: string; labels: string[]; revision: number; canWrite: boolean;
}
export const fileDetails = (fileId: string) => call<FileDetails>(`/files/${encodeURIComponent(fileId)}/details`);
export const updateFileDetails = (fileId: string, description: string, labels: string[], expectedRevision: number) =>
  call<FileDetails>(`/files/${encodeURIComponent(fileId)}/details`, { method: 'PATCH', body: JSON.stringify({ description, labels, expectedRevision }) });

export interface ListingPage<T> { entries: T[]; next: string | null }

/** Follow the server's page link, retaining filters and rejecting another route/origin. */
async function readPage<T>(route: string, next: string | null, label = 'listing', selectedSite = site): Promise<ListingPage<T>> {
  const path = `${API}${route}`;
  const origin = window.location.origin;
  const continuation = (link: string) => {
    const url = new URL(link, origin);
    if (url.origin !== origin || url.pathname !== path) throw new Error(`Invalid ${label} continuation.`);
    return url;
  };
  const url = next ? continuation(next) : new URL(path, origin);
  const res = await request(`${url.pathname.slice(API.length)}${url.search}`, undefined, selectedSite);
  const entries = await res.json() as T[];
  const match = res.headers.get('Link')?.match(/<([^>]+)>;\s*rel="next"/);
  const following = match ? continuation(match[1]!).toString() : null;
  if (following && following === next) throw new Error('Listing did not advance. Try refreshing.');
  return { entries, next: following };
}

export function appendRows<T extends { id: string }>(rows: T[], incoming: T[]): T[] {
  const seen = new Set(rows.map(row => row.id));
  return [...rows, ...incoming.filter(row => { if (seen.has(row.id)) return false; seen.add(row.id); return true; })];
}

/** History is a bare array with its continuation in Link; never infer the end from row count. */
export async function fileVersionsPage(fileId: string, next: string | null = null): Promise<{ versions: FileVersion[]; next: string | null }> {
  const page = await readPage<FileVersion>(`/files/${encodeURIComponent(fileId)}/versions`, next, 'version-history');
  return { versions: page.entries, next: page.next };
}

export const keepVersion = (fileId: string, versionId: string, keep: boolean) =>
  call<FileVersion>(`/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}`, { method: 'PATCH', body: JSON.stringify({ keep }) });

export const restoreVersion = (fileId: string, versionId: string) =>
  call<DriveFile>(`/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}/restore`, { method: 'POST' });

/** The spaces this login is bound in, one of them flagged as the one in view. */
export const listSites = () => call<Site[]>('/sites');

/** The folders directly inside a folder. Paged, so a bare array like the file listing. */
export const listFolders = (folderId: string) =>
  call<DriveFolder[]>(`/folders/${encodeURIComponent(folderId)}/folders`);

export const listFolderPage = (folderId: string, next: string | null = null) =>
  readPage<DriveFile>(`/folders/${encodeURIComponent(folderId)}/files`, next);

export const listTrashPage = (next: string | null = null) => readPage<DriveFile>('/trash', next);

export const listFoldersPage = (folderId: string, next: string | null = null, selectedSite = site) =>
  readPage<DriveFolder>(`/folders/${encodeURIComponent(folderId)}/folders`, next, 'listing', selectedSite);

export const listSharedFolders = () => call<{ folders: DriveFolder[] }>('/folders/shared-with-me');

/**
 * A folder by its path, or null. `null` is also the answer for a folder the caller may
 * not read — the worker refuses indistinguishably on purpose, so a path cannot be used
 * to probe the tree one guess at a time.
 */
export const getFolder = (folderId: string) => call<DriveFolder & { canManage: boolean }>(`/folders/${encodeURIComponent(folderId)}/metadata`);

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
export const moveFile = (fileId: string, folderId: string, selectedSite = site) =>
  call<DriveFile>(`/files/${encodeURIComponent(fileId)}/move`, {
    method: 'POST',
    body: JSON.stringify({ folderId }),
  }, selectedSite);

export const moveFolder = (folderId: string, parentId: string, selectedSite = site) =>
  call<DriveFolder>(`/folders/${encodeURIComponent(folderId)}/move`, {
    method: 'POST',
    body: JSON.stringify({ parentId }),
  }, selectedSite);

/** Recoverable: the bytes stay, and `restoreFile` puts it back under the same name. */
export const trashFile = (fileId: string, selectedSite = site) =>
  call<DriveFile>(`/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }, selectedSite);

export const restoreFile = (fileId: string, selectedSite = site) =>
  call<DriveFile>(`/files/${encodeURIComponent(fileId)}/restore`, { method: 'POST' }, selectedSite);

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

export const search = (term: string, limit?: number, via?: SearchHit['via']) =>
  call<{ hits: SearchHit[] }>(
    `/search?term=${encodeURIComponent(term)}${limit ? `&limit=${limit}` : ''}${via ? `&via=${encodeURIComponent(via)}` : ''}`,
  );

export interface SearchHit extends DriveFile {
  snippet?: string | null;
  via: 'name' | 'content' | 'metadata';
}

/** What is in the trash, scope-wide — a trashed file's folder is where it goes back to. */
export const listTrash = () => call<DriveFile[]>('/trash');

/**
 * Upload bytes and record the version that names them, in one call the worker
 * composes: ensure-file → attachment upload → record-version. The size and type the
 * version records come from the stored bytes, not from anything said here.
 */
export async function uploadFile(folderId: string, file: File, selectedSite: string | null = currentSite(), signal?: AbortSignal): Promise<DriveFile> {
  const res = await fetch(
    `${API}/folders/${encodeURIComponent(folderId)}/content?name=${encodeURIComponent(file.name)}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': file.type || 'application/octet-stream', ...(selectedSite ? { 'x-site': selectedSite } : {}) },
      body: file,
      signal,
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

/** Stream an immutable version through the same selected-space attachment gate. */
export function versionContentUrl(fileId: string, versionId: string): string {
  const q = site ? `?site=${encodeURIComponent(site)}` : '';
  return `${API}/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}/content${q}`;
}

/** The relying-party routes the worker mounts. Full page loads: the issuer owns the redirect. */
export const LOGIN_URL = `${API}/auth/login`;
export const LOGOUT_URL = `${API}/auth/logout`;

/** Conditional text save: the server preserves MIME and compares the version atomically. */
export function saveText(fileId: string, expectedVersion: string, text: string): Promise<DriveFile> {
  return call(`/files/${encodeURIComponent(fileId)}/content?expectedVersion=${encodeURIComponent(expectedVersion)}`, {
    method: 'PUT', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: text,
  });
}

export interface SpaceRequest { id: string; slug: string; name: string; status: 'pending' | 'done' | 'failed'; error: string | null; requestedAt?: string }
export const requestSpace = (name: string, slug: string, settings?: import('../../src/space-settings').SpaceSettings) => call<{ id: string; slug: string; name: string }>('/sites', { method: 'POST', body: JSON.stringify({ name, slug, settings }) });
export const spaceRequests = () => call<{ requests: SpaceRequest[] }>('/site-requests');

export const getSpaceSettings = () => call<import('../../src/space-settings').SpaceSettings>('/space-settings');
export const updateSpaceSettings = (settings: import('../../src/space-settings').SpaceSettings) => call<import('../../src/space-settings').SpaceSettings>('/space-settings', {method:'PATCH',body:JSON.stringify(settings)});
export interface PluginInstall { id: string; plugin_id: string; principal: string; manifest_json: string; source?: string; source_kind?: string; source_ref?: string; resolved?: string; source_sha256?: string; granted_capabilities?: string; enabled: number; updated_at: string }
export const listPlugins = () => call<{ plugins: PluginInstall[] }>('/plugins');
export type PluginProvenance = { kind: 'inline' | 'github' | 'npm' | 'zip' | 'bundled'; ref: string; resolved: string };
export const importGithubPlugin = (repo: string, ref?: string, path?: string) => call<{manifest: unknown; source: string; provenance: PluginProvenance}>('/plugin-import/github', {method:'POST', body:JSON.stringify({repo,ref:ref || undefined,path:path || undefined})});
export const savePlugin = (manifest: unknown, source: string, expectedRevision: string | null, forSpace = false, acceptCapabilities?: unknown, provenance?: PluginProvenance) => call<PluginInstall>('/plugins', {method: 'PUT', body: JSON.stringify({manifest, source, expectedRevision, forSpace, acceptCapabilities, provenance})});
export const togglePlugin = (id: string, enabled: boolean) => call<PluginInstall>(`/plugins/${encodeURIComponent(id)}`, {method: 'PATCH', body: JSON.stringify({enabled})});
export const removePlugin = (id: string) => call<{id: string}>(`/plugins/${encodeURIComponent(id)}`, {method: 'DELETE'});

export const pluginSource = (id:string,revision:string) => call<PluginInstall & {source:string}>(`/plugins/${encodeURIComponent(id)}/source?revision=${encodeURIComponent(revision)}`);
