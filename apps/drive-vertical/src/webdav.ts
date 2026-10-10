/**
 * WebDAV (RFC 4918) for the drive vertical (#299), so a space can be mounted in Finder,
 * Explorer or any DAV client at `…/dav/`.
 *
 * The namespace is built from the caller's spaces, per request:
 *
 *   /dav/                          every space this login can enter, one collection each
 *   /dav/<Space>/<folders…>/<file> the space's own folder tree
 *   /dav/Shared with me/           folders granted directly to this login, across spaces
 *   /dav/Shared with me/<mount>/…  one of those folders and its subtree
 *
 * Nothing about access is decided here. Every read and write is a scope operation or an
 * attachment call made as the caller's principal in that space, so the kernel's checks
 * apply exactly as they do to the browser. The namespace is rebuilt on every request,
 * which is what makes a revoked membership or grant fail even at a URL the client already
 * knows: the space or mount is simply no longer there.
 *
 * Names are collision-safe. Two spaces with one name get their slug appended. A space
 * named "Shared with me" keeps that name, and the virtual collection moves to
 * "Shared with me (Canopy 1)". A mount is named after its folder and space, with a key
 * derived from (space, folder id); the key alone finds the mount, so its URL survives a
 * rename of the folder.
 *
 * Writes follow the drive's model. PUT records a new version (the old one stays in the
 * history); DELETE of a file moves it to Trash. A name held by a file in Trash cannot be
 * reused until that file is restored or purged, and is reported as 409. Unsupported
 * operations answer 403 with a reason: deleting a folder, copying a folder, and moving
 * anything across spaces. Locks are not enforced: LOCK hands back a token because macOS
 * Finder only mounts read-write when it sees lock support (DAV class 2).
 */
import type { Context, Env, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { errorCodeOf } from '@substrat-run/contracts';
import { readBounded } from './upload-limit';

export interface DavFolder { id: string; parent_id: string; path: string; name: string; created_at?: string }
export interface DavFile { id: string; folder_id: string; name: string; current_version_id: string | null; created_at: string; updated_at: string }
export interface DavVersion { id: string; source: string; blob_ref: string | null; mime: string; size: number | null; created_at: string }

/** One space as the caller reaches it: every call is made as their principal there. */
export interface DavScope {
  invoke<T>(operation: string, input: Record<string, unknown>): Promise<T>;
  /** Store bytes against a file; returns the attachment id a version can name. */
  upload(fileId: string, name: string, mime: string, body: Uint8Array): Promise<string>;
  open(blobRef: string): Promise<{ body: BodyInit; contentType: string } | null>;
  /** Index the text of a version just written. Runs after the response where possible. */
  afterWrite(file: { id: string; versionId: string; name: string; mime: string }, bytes: Uint8Array): Promise<void>;
}
export interface DavSpace { slug: string; name: string; scope: DavScope }

/** Spaces for a presented password, or null when it is not a valid app password. */
export type DavAuthenticate<E extends Env> = (c: Context<E>, password: string, username: string) => Promise<DavSpace[] | null>;

const ROOT = '/dav';
const SHARED = 'Shared with me';
const ALLOW = 'OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, LOCK, UNLOCK';

const MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', heic: 'image/heic', md: 'text/markdown', txt: 'text/plain',
  csv: 'text/csv', json: 'application/json', xml: 'application/xml', html: 'text/html', zip: 'application/zip',
  mp3: 'audio/mpeg', mp4: 'video/mp4', mov: 'video/quicktime',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const mimeFor = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/** Types a browser would run as a page; served as downloads. */
const ACTIVE_TYPES = new Set(['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/xml']);

/** Finder and Windows metadata files: accepted and discarded so they never reach the drive. */
const isJunk = (name: string) => name === '.DS_Store' || name === '.localized' || name === 'Thumbs.db' || name === 'desktop.ini' || name.startsWith('._');

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const httpDate = (iso: string) => new Date(iso).toUTCString();
const href = (segs: string[], collection: boolean) => {
  const encoded = segs.map(encodeURIComponent).join('/');
  return `${ROOT}/${encoded}${collection && encoded ? '/' : ''}`;
};

const LOCKS =
  '<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>'
  + '<D:lockentry><D:lockscope><D:shared/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>';

function collectionXml(segs: string[], name: string, modified?: string | null): string {
  return `<D:response><D:href>${href(segs, true)}</D:href><D:propstat><D:prop>`
    + `<D:resourcetype><D:collection/></D:resourcetype><D:displayname>${xml(name)}</D:displayname>`
    + (modified ? `<D:getlastmodified>${httpDate(modified)}</D:getlastmodified>` : '')
    + `${LOCKS}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function fileXml(segs: string[], file: DavFile, size: number | null, mime: string | null): string {
  return `<D:response><D:href>${href(segs, false)}</D:href><D:propstat><D:prop>`
    + `<D:resourcetype/><D:displayname>${xml(file.name)}</D:displayname>`
    + `<D:getcontentlength>${size ?? 0}</D:getcontentlength>`
    + `<D:getcontenttype>${xml(mime ?? mimeFor(file.name))}</D:getcontenttype>`
    + `<D:getlastmodified>${httpDate(file.updated_at)}</D:getlastmodified>`
    + `<D:creationdate>${new Date(file.created_at).toISOString()}</D:creationdate>`
    + (file.current_version_id ? `<D:getetag>"${xml(file.current_version_id)}"</D:getetag>` : '')
    + `${LOCKS}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

const multistatus = (responses: string[]) =>
  `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`;
const XML = { 'content-type': 'application/xml; charset=utf-8' };

const text = (status: number, message: string, headers: Record<string, string> = {}) =>
  new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } });

/** Thrown inside a handler to answer with a status and a reason. */
class DavError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** A collection name: one segment, with the separators a client would split on removed. */
const segmentName = (value: string) => value.replace(/[/\\]/g, '-').trim() || 'Untitled';

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

interface Mount { key: string; segment: string; displayName: string; space: DavSpace; folder: DavFolder }

/** The caller's namespace for this request. */
class Namespace {
  readonly spaceSegments = new Map<string, DavSpace>();
  readonly sharedSegment: string;
  private mounts?: Promise<Mount[]>;

  constructor(readonly spaces: DavSpace[]) {
    const counts = new Map<string, number>();
    for (const space of spaces) counts.set(segmentName(space.name), (counts.get(segmentName(space.name)) ?? 0) + 1);
    for (const space of spaces) {
      const base = segmentName(space.name);
      this.spaceSegments.set(counts.get(base)! > 1 ? `${base} (${space.slug})` : base, space);
    }
    let shared = SHARED;
    for (let n = 1; this.spaceSegments.has(shared); n++) shared = `${SHARED} (Canopy ${n})`;
    this.sharedSegment = shared;
  }

  /** Folders granted directly to this login, recomputed per request so a revoked grant vanishes. */
  sharedMounts(): Promise<Mount[]> {
    this.mounts ??= Promise.all(this.spaces.map(async (space) => {
      try {
        const { folders } = await space.scope.invoke<{ folders: DavFolder[] }>('drive/list-shared-folders', {});
        return await Promise.all(folders.map(async (folder) => {
          const key = (await sha256Hex(`${space.slug}\n${folder.id}`)).slice(0, 12);
          const label = Array.from(segmentName(folder.name)).slice(0, 60).join('');
          const spaceName = segmentName(space.name);
          return { key, space, folder, segment: `${label} — ${spaceName} [${key}]`, displayName: `${folder.name} — ${space.name}` };
        }));
      } catch {
        // One unreachable space must not hide the grants in the others.
        return [];
      }
    })).then((groups) => groups.flat());
    return this.mounts;
  }
}

type Location =
  | { kind: 'root' }
  | { kind: 'shared' }
  /** `base` is the folder path the segments start from: '' for a space, the folder's path for a mount. */
  | { kind: 'space'; space: DavSpace; prefix: string[]; base: string; tail: string[] };

async function locate(ns: Namespace, segs: string[]): Promise<Location | null> {
  if (segs.length === 0) return { kind: 'root' };
  const space = ns.spaceSegments.get(segs[0]!);
  if (space) return { kind: 'space', space, prefix: segs.slice(0, 1), base: '', tail: segs.slice(1) };
  if (segs[0] !== ns.sharedSegment) return null;
  if (segs.length === 1) return (await ns.sharedMounts()).length ? { kind: 'shared' } : null;
  const key = /\[([0-9a-f]{12})\]$/.exec(segs[1]!)?.[1];
  const mount = key ? (await ns.sharedMounts()).find((m) => m.key === key) : undefined;
  if (!mount) return null;
  return { kind: 'space', space: mount.space, prefix: segs.slice(0, 2), base: mount.folder.path, tail: segs.slice(2) };
}

const join = (base: string, tail: string[]) => [base, ...tail].filter(Boolean).join('/');

type Target =
  | { kind: 'folder'; folder: DavFolder }
  | { kind: 'file'; parent: DavFolder; file: DavFile; version: DavVersion | null; canWrite: boolean }
  | { kind: 'missing'; parent: DavFolder | null; name: string };

/**
 * What a path in a space names. A folder and a file may share a name in the drive, so a
 * trailing slash asks for the folder; without one the file wins and the folder is the
 * fallback.
 */
async function resolve(scope: DavScope, base: string, tail: string[], wantsCollection: boolean): Promise<Target> {
  const path = join(base, tail);
  if (!tail.length || wantsCollection) {
    const folder = await scope.invoke<DavFolder | null>('drive/folder-by-path', { path });
    if (folder) return { kind: 'folder', folder };
    if (!tail.length) throw new DavError(404, 'Not found');
  }
  const name = tail.at(-1)!;
  const parent = await scope.invoke<DavFolder | null>('drive/folder-by-path', { path: join(base, tail.slice(0, -1)) });
  if (!parent) return { kind: 'missing', parent: null, name };
  if (!wantsCollection) {
    const found = await scope.invoke<{ file: DavFile; version: DavVersion | null; canWrite: boolean } | null>(
      'drive/file-by-name', { folderId: parent.id, name },
    );
    if (found) return { kind: 'file', parent, ...found };
    const folder = await scope.invoke<DavFolder | null>('drive/folder-by-path', { path });
    if (folder) return { kind: 'folder', folder };
  }
  return { kind: 'missing', parent, name };
}

async function* childFolders(scope: DavScope, folderId: string) {
  let cursor: string | undefined;
  do {
    const page = await scope.invoke<{ entries: DavFolder[]; nextCursor?: string | null }>(
      'drive/list-folders', { folderId, limit: 200, ...(cursor ? { cursor } : {}) },
    );
    yield* page.entries;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}

async function* childFiles(scope: DavScope, folderId: string) {
  let after: string | undefined;
  do {
    const page = await scope.invoke<{ entries: (DavFile & { size: number | null; mime: string | null })[]; next: string | null }>(
      'drive/list-file-entries', { folderId, limit: 500, ...(after ? { after } : {}) },
    );
    yield* page.entries;
    after = page.next ?? undefined;
  } while (after);
}

/** Read a file's current bytes through the attachment gate. */
async function readBytes(scope: DavScope, version: DavVersion | null): Promise<{ bytes: Uint8Array; mime: string }> {
  if (!version) return { bytes: new Uint8Array(), mime: 'application/octet-stream' };
  if (version.source !== 'blob' || !version.blob_ref) throw new DavError(501, 'This file lives in a connected source, which WebDAV cannot read yet');
  const opened = await scope.open(version.blob_ref);
  if (!opened) throw new DavError(404, 'The bytes this version names are gone');
  return { bytes: new Uint8Array(await new Response(opened.body).arrayBuffer()), mime: opened.contentType || version.mime };
}

/** Write bytes as a new version of a (possibly new) file. Returns whether the file was created. */
async function writeFile(scope: DavScope, parent: DavFolder, name: string, existing: DavFile | null, bytes: Uint8Array, mime: string): Promise<boolean> {
  let file = existing;
  if (!file) {
    try {
      file = await scope.invoke<DavFile>('drive/ensure-file', { folderId: parent.id, name });
    } catch (e) {
      if (errorCodeOf(e) === 'conflict') throw new DavError(409, `A file named '${name}' is in Trash. Restore or rename it in the drive first.`);
      throw e;
    }
  }
  const blobRef = await scope.upload(file.id, name, mime, bytes);
  const written = await scope.invoke<{ id: string; current_version_id: string | null }>(
    'drive/record-version', { fileId: file.id, location: { source: 'blob', blobRef } },
  );
  if (written.current_version_id) await scope.afterWrite({ id: file.id, versionId: written.current_version_id, name, mime }, bytes);
  return !existing;
}

function basicCredentials(header: string | undefined): { username: string; password: string } | null {
  if (!header?.startsWith('Basic ')) return null;
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(header.slice(6).trim()), (ch) => ch.charCodeAt(0)));
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  return colon < 0 ? null : { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/** Request path → decoded segments. `.`/`..` and encoded separators are refused, not normalized. */
function segmentsOf(pathname: string): { segs: string[]; collection: boolean } | null {
  if (pathname !== ROOT && !pathname.startsWith(`${ROOT}/`)) return null;
  const raw = pathname.slice(ROOT.length).split('/').filter(Boolean);
  const segs: string[] = [];
  for (const part of raw) {
    let seg: string;
    try {
      seg = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (seg === '.' || seg === '..' || seg.includes('/') || seg.includes('\\')) return null;
    segs.push(seg);
  }
  return { segs, collection: pathname.endsWith('/') };
}

function destinationOf(c: Context): { segs: string[]; collection: boolean } | null {
  const header = c.req.header('Destination');
  if (!header) return null;
  let url: URL;
  try {
    url = new URL(header, c.req.url);
  } catch {
    return null;
  }
  return segmentsOf(url.pathname);
}

function statusFor(e: unknown): Response | null {
  if (e instanceof DavError) return text(e.status, e.message);
  if (e instanceof HTTPException) return text(e.status, e.message);
  switch (errorCodeOf(e)) {
    case 'not_found': return text(404, 'Not found');
    case 'forbidden':
    case 'permission_denied': return text(403, 'Forbidden');
    case 'conflict': return text(409, e instanceof Error ? e.message : 'Conflict');
    case 'validation_failed': return text(400, e instanceof Error ? e.message : 'Invalid request');
    case 'precondition_failed': return text(412, 'Precondition failed');
    case 'unauthenticated': return text(401, 'Unauthorized', { 'www-authenticate': 'Basic realm="Canopy", charset="UTF-8"' });
    default: return null;
  }
}

/** Mount `/dav` on the app. `authenticate` turns an app password into the caller's spaces. */
export function mountWebdav<E extends Env>(app: Hono<E>, authenticate: DavAuthenticate<E>): void {
  const paths = [ROOT, `${ROOT}/*`];

  const handle = (fn: (c: Context<E>, ns: Namespace, at: { segs: string[]; collection: boolean }) => Promise<Response>) =>
    async (c: Context<E>) => {
      const at = segmentsOf(new URL(c.req.url).pathname);
      const creds = basicCredentials(c.req.header('Authorization'));
      const spaces = creds ? await authenticate(c, creds.password, creds.username) : null;
      if (!spaces) return text(401, 'Unauthorized', { 'www-authenticate': 'Basic realm="Canopy", charset="UTF-8"' });
      if (!at) return text(404, 'Not found');
      try {
        return await fn(c, new Namespace(spaces), at);
      } catch (e) {
        const response = statusFor(e);
        if (response) return response;
        throw e;
      }
    };

  /** A location inside a space, or a refusal naming what the virtual levels cannot do. */
  const inSpace = async (ns: Namespace, segs: string[], action: string) => {
    const loc = await locate(ns, segs);
    if (!loc) throw new DavError(404, 'Not found');
    if (loc.kind !== 'space' || !loc.tail.length) throw new DavError(403, `Cannot ${action} a space or the Shared with me collection`);
    return loc;
  };

  app.on('OPTIONS', paths, () => new Response(null, {
    status: 200, headers: { DAV: '1, 2', Allow: ALLOW, 'MS-Author-Via': 'DAV' },
  }));

  app.on('PROPFIND', paths, handle(async (c, ns, at) => {
    const depth = c.req.header('Depth') === '0' ? 0 : 1;
    const loc = await locate(ns, at.segs);
    if (!loc) return text(404, 'Not found');
    const out: string[] = [];
    if (loc.kind === 'root') {
      out.push(collectionXml([], 'Canopy'));
      if (depth) {
        for (const segment of ns.spaceSegments.keys()) out.push(collectionXml([segment], segment));
        if ((await ns.sharedMounts()).length) out.push(collectionXml([ns.sharedSegment], SHARED));
      }
    } else if (loc.kind === 'shared') {
      out.push(collectionXml(at.segs, SHARED));
      if (depth) for (const mount of await ns.sharedMounts()) out.push(collectionXml([...at.segs, mount.segment], mount.displayName));
    } else {
      const target = await resolve(loc.space.scope, loc.base, loc.tail, at.collection);
      if (target.kind === 'missing') return text(404, 'Not found');
      const segs = [...loc.prefix, ...loc.tail];
      if (target.kind === 'file') {
        out.push(fileXml(segs, target.file, target.version?.size ?? null, target.version?.mime ?? null));
      } else {
        out.push(collectionXml(segs, loc.tail.at(-1) ?? at.segs.at(-1)!, target.folder.created_at));
        if (depth) {
          for await (const folder of childFolders(loc.space.scope, target.folder.id)) out.push(collectionXml([...segs, folder.name], folder.name, folder.created_at));
          for await (const file of childFiles(loc.space.scope, target.folder.id)) out.push(fileXml([...segs, file.name], file, file.size, file.mime));
        }
      }
    }
    return new Response(multistatus(out), { status: 207, headers: XML });
  }));

  // Clients set timestamps and Finder flags; they are not stored, but refusing them fails saves.
  app.on('PROPPATCH', paths, handle(async (_c, _ns, at) => new Response(multistatus([
    `<D:response><D:href>${href(at.segs, at.collection)}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
  ]), { status: 207, headers: XML })));

  app.on('LOCK', paths, handle(async (_c, _ns, at) => {
    const token = `opaquelocktoken:${crypto.randomUUID()}`;
    const body = '<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>'
      + '<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>0</D:depth>'
      + `<D:timeout>Second-3600</D:timeout><D:locktoken><D:href>${token}</D:href></D:locktoken>`
      + `<D:lockroot><D:href>${href(at.segs, at.collection)}</D:href></D:lockroot></D:activelock></D:lockdiscovery></D:prop>`;
    return new Response(body, { status: 200, headers: { ...XML, 'Lock-Token': `<${token}>` } });
  }));

  app.on('UNLOCK', paths, handle(async () => new Response(null, { status: 204 })));

  const serve = (withBody: boolean) => handle(async (_c, ns, at) => {
    const loc = await locate(ns, at.segs);
    if (!loc) return text(404, 'Not found');
    if (loc.kind !== 'space') return text(405, 'A collection has no content', { Allow: ALLOW });
    const target = await resolve(loc.space.scope, loc.base, loc.tail, at.collection);
    if (target.kind === 'missing') return text(404, 'Not found');
    if (target.kind === 'folder') return text(405, 'A collection has no content', { Allow: ALLOW });
    const version = target.version;
    const contentType = version?.mime ?? mimeFor(target.file.name);
    // Bytes are served from the app's own origin. A browser that has the Basic
    // credentials cached must not run an uploaded page as the app: everything is
    // sandboxed, and active types download instead of rendering, as in `file-content.ts`.
    const active = ACTIVE_TYPES.has(contentType.split(';')[0]!.trim().toLowerCase());
    const headers: Record<string, string> = {
      'content-type': contentType,
      'content-length': String(version?.size ?? 0),
      'last-modified': httpDate(target.file.updated_at),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      ...(active ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(target.file.name)}` } : {}),
      ...(version ? { etag: `"${version.id}"` } : {}),
    };
    if (!withBody) return new Response(null, { status: 200, headers });
    if (!version) return new Response(null, { status: 200, headers });
    if (version.source !== 'blob' || !version.blob_ref) return text(501, 'This file lives in a connected source, which WebDAV cannot read yet');
    const opened = await loc.space.scope.open(version.blob_ref);
    if (!opened) return text(404, 'The bytes this version names are gone');
    return new Response(opened.body, { status: 200, headers });
  });
  app.on('HEAD', paths, serve(false));
  app.on('GET', paths, serve(true));

  app.on('PUT', paths, handle(async (c, ns, at) => {
    if (at.collection) return text(405, 'Cannot write content to a collection');
    const loc = await inSpace(ns, at.segs, 'write to');
    const name = loc.tail.at(-1)!;
    if (isJunk(name)) {
      await c.req.raw.body?.cancel();
      return new Response(null, { status: 201 });
    }
    const target = await resolve(loc.space.scope, loc.base, loc.tail, false);
    if (target.kind === 'folder') return text(405, 'A folder has this name');
    if (!target.parent) return text(409, 'The parent folder does not exist');
    if (target.kind === 'file' && !target.canWrite) return text(403, 'Forbidden');
    const declared = c.req.header('content-type')?.split(';')[0]?.trim();
    const mime = declared && declared !== 'application/octet-stream' ? declared : mimeFor(name);
    const bytes = await readBounded(c.req.raw);
    const created = await writeFile(loc.space.scope, target.parent, name, target.kind === 'file' ? target.file : null, bytes, mime);
    return new Response(null, { status: created ? 201 : 204 });
  }));

  app.on('MKCOL', paths, handle(async (c, ns, at) => {
    if (c.req.header('content-length') && c.req.header('content-length') !== '0') return text(415, 'MKCOL does not take a body');
    const loc = await locate(ns, at.segs);
    if (!loc) return text(409, 'The parent collection does not exist');
    if (loc.kind !== 'space' || !loc.tail.length) return text(405, 'Already exists');
    const target = await resolve(loc.space.scope, loc.base, loc.tail, true);
    if (target.kind !== 'missing') return text(405, 'Already exists');
    if (!target.parent) return text(409, 'The parent folder does not exist');
    try {
      await loc.space.scope.invoke('drive/create-folder', { parentId: target.parent.id, name: target.name });
    } catch (e) {
      if (errorCodeOf(e) === 'conflict') return text(405, 'Already exists');
      throw e;
    }
    return new Response(null, { status: 201 });
  }));

  app.on('DELETE', paths, handle(async (_c, ns, at) => {
    if (at.segs.length && isJunk(at.segs.at(-1)!)) return new Response(null, { status: 204 });
    const loc = await inSpace(ns, at.segs, 'delete');
    const target = await resolve(loc.space.scope, loc.base, loc.tail, at.collection);
    if (target.kind === 'missing') return text(404, 'Not found');
    if (target.kind === 'folder') return text(403, 'Folders cannot be deleted over WebDAV. Move their files to Trash, or use the drive.');
    await loc.space.scope.invoke('drive/trash-file', { fileId: target.file.id });
    return new Response(null, { status: 204 });
  }));

  const transfer = (mode: 'move' | 'copy') => handle(async (c, ns, at) => {
    const dest = destinationOf(c);
    if (!dest) return text(400, 'A Destination inside /dav is required');
    if (isJunk(at.segs.at(-1) ?? '') || isJunk(dest.segs.at(-1) ?? '')) return new Response(null, { status: 204 });
    const overwrite = (c.req.header('Overwrite') ?? 'T').toUpperCase() !== 'F';
    const from = await inSpace(ns, at.segs, mode);
    const to = await inSpace(ns, dest.segs, `${mode} onto`);
    const source = await resolve(from.space.scope, from.base, from.tail, at.collection);
    if (source.kind === 'missing') return text(404, 'Not found');
    if (mode === 'move' && from.space.slug !== to.space.slug) return text(403, 'Moving between spaces is not supported. Copy the file, then delete the original.');
    const destination = await resolve(to.space.scope, to.base, to.tail, source.kind === 'folder');
    if (destination.kind === 'missing' && !destination.parent) return text(409, 'The destination folder does not exist');

    if (source.kind === 'folder') {
      if (mode === 'copy') return text(403, 'Copying folders over WebDAV is not supported');
      if (destination.kind === 'folder') {
        if (destination.folder.id === source.folder.id) return new Response(null, { status: 204 });
        return overwrite ? text(403, 'Replacing a folder is not supported') : text(412, 'The destination exists');
      }
      if (destination.kind === 'file') return text(409, 'A file has the destination name');
      return relocate(from.space.scope, 'folder', source.folder.id, source.folder.parent_id, source.folder.name, destination.parent!.id, destination.name);
    }

    if (destination.kind === 'folder') return text(409, 'A folder has the destination name');
    if (destination.kind === 'file') {
      if (destination.file.id === source.file.id) return new Response(null, { status: 204 });
      if (!overwrite) return text(412, 'The destination exists');
      // Overwrite becomes a new version of the destination, so its history is kept.
      // Editors that save by writing a temporary file and renaming it rely on this.
      if (!destination.canWrite) return text(403, 'Forbidden');
      const { bytes, mime } = await readBytes(from.space.scope, source.version);
      await writeFile(to.space.scope, destination.parent, destination.file.name, destination.file, bytes, mime);
      if (mode === 'move') await from.space.scope.invoke('drive/trash-file', { fileId: source.file.id });
      return new Response(null, { status: 204 });
    }
    if (mode === 'copy') {
      const { bytes, mime } = await readBytes(from.space.scope, source.version);
      await writeFile(to.space.scope, destination.parent!, destination.name, null, bytes, mime);
      return new Response(null, { status: 201 });
    }
    return relocate(from.space.scope, 'file', source.file.id, source.parent.id, source.file.name, destination.parent!.id, destination.name);
  });

  app.on('MOVE', paths, transfer('move'));
  app.on('COPY', paths, transfer('copy'));
}

/**
 * A rename, a move, or both. The drive has no single operation for both, so the move runs
 * first and is undone if the rename then fails, leaving the item where it was.
 */
async function relocate(scope: DavScope, kind: 'file' | 'folder', id: string, fromParent: string, fromName: string, toParent: string, toName: string): Promise<Response> {
  const idKey = kind === 'file' ? 'fileId' : 'folderId';
  const moved = fromParent !== toParent;
  if (moved) await scope.invoke(`drive/move-${kind}`, kind === 'file' ? { fileId: id, folderId: toParent } : { folderId: id, parentId: toParent });
  if (fromName !== toName) {
    try {
      await scope.invoke(`drive/rename-${kind}`, { [idKey]: id, name: toName });
    } catch (e) {
      if (moved) {
        await scope.invoke(`drive/move-${kind}`, kind === 'file' ? { fileId: id, folderId: fromParent } : { folderId: id, parentId: fromParent }).catch(() => {});
      }
      throw e;
    }
  }
  return new Response(null, { status: 201 });
}
