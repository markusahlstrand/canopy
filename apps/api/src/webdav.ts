import type { Hono, Context } from "hono";
import {
  NotFoundError,
  PermissionError,
  type BlobStore,
  type FileService,
  type FileWithVersion,
  type Role,
  type VerifiedShare,
} from "@canopy/store";

/**
 * WebDAV (RFC 4918) so the drive can be mounted in Finder / Explorer over
 * `…/dav`. Auth is HTTP Basic — Finder can't do OIDC — and resolves to one of
 * two **principals**:
 *   • an **app password** → acts as its owner; the mount root lists their
 *     personal space plus each group space as a top-level collection.
 *   • a **share secret** → a scoped capability that acts *as the share's
 *     creator* but is rooted at the shared file/folder/space and can't escape
 *     it; a viewer share is read-only. The secret rides in the Authorization
 *     header (redacted from logs), never the URL — so the mount URL is the bare
 *     `…/dav` and the secret decides what it points at.
 * On a failed handshake we log the (sanitized) Basic username so a wrong-password
 * attempt is still attributable to a person or a specific link.
 *
 * Read + write: OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, DELETE, MKCOL,
 * MOVE, COPY, LOCK, UNLOCK. We advertise DAV class **2** (`1, 2`) and answer
 * LOCK/UNLOCK — macOS Finder only mounts a share read-write if it sees lock
 * support. Locks aren't enforced (single drive, single owner); we hand back a
 * token so Finder is happy. Writes are scoped to a single space; moving/copying
 * across the top-level group-space boundary is rejected (see MOVE/COPY).
 *
 * macOS sprays `.DS_Store` / `._*` AppleDouble files as it browses; we accept
 * and discard those so the drive (and the web UI) stays clean.
 */

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json",
};
const mimeFor = (name: string) => MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rfc1123 = (iso?: string) => (iso ? new Date(iso) : new Date()).toUTCString();

/** macOS/Finder metadata files we accept-and-discard so they never hit the drive. */
const isJunk = (name: string) => name === ".DS_Store" || name === ".localized" || name.startsWith("._");

/** Build a /dav href from path segments; collections get a trailing slash. */
function davHref(segs: string[], isCollection: boolean): string {
  const enc = segs.map(encodeURIComponent).join("/");
  return `/dav/${enc}${isCollection && enc ? "/" : ""}`;
}

// Advertise lock support in PROPFIND so Finder treats resources as writable.
const SUPPORTEDLOCK =
  "<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>" +
  "<D:lockentry><D:lockscope><D:shared/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock><D:lockdiscovery/>";

function collectionXml(href: string, name: string): string {
  return (
    `<D:response><D:href>${href}</D:href><D:propstat><D:prop>` +
    `<D:resourcetype><D:collection/></D:resourcetype>` +
    `<D:displayname>${xmlEscape(name)}</D:displayname>${SUPPORTEDLOCK}` +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  );
}

function fileXml(segs: string[], file: FileWithVersion): string {
  const size = file.version?.size ?? 0;
  const ctype = file.version?.mime ?? mimeFor(file.name);
  return (
    `<D:response><D:href>${davHref(segs, false)}</D:href><D:propstat><D:prop>` +
    `<D:resourcetype/>` +
    `<D:displayname>${xmlEscape(file.name)}</D:displayname>` +
    `<D:getcontentlength>${size}</D:getcontentlength>` +
    `<D:getlastmodified>${rfc1123(file.updatedAt)}</D:getlastmodified>` +
    `<D:getcontenttype>${xmlEscape(ctype)}</D:getcontenttype>${SUPPORTEDLOCK}` +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  );
}

const multistatus = (responses: string[]) =>
  `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${responses.join("")}</D:multistatus>`;

const XML = { "Content-Type": "application/xml; charset=utf-8" } as const;

/** The authenticated WebDAV principal: an app password (the user) or a share secret (a capability). */
type Principal =
  | { kind: "user"; sub: string }
  | { kind: "share"; sub: string; role: Role; share: VerifiedShare };

const isReadOnly = (p: Principal) => p.kind === "share" && p.role !== "editor";

export function registerWebdav(app: Hono, deps: { service: FileService; blobs: BlobStore }): void {
  const { service, blobs } = deps;
  const paths = ["/dav", "/dav/*"];

  // Split a /dav URL pathname into decoded segments. We drop "." and ".." so a
  // share mount can never be walked above its rooted subtree (defense in depth).
  const segsFrom = (pathname: string): string[] => {
    const raw = pathname.replace(/^\/dav\/?/, "");
    return raw ? raw.split("/").map(decodeURIComponent).filter((s) => s && s !== "." && s !== "..") : [];
  };
  const segsOf = (c: Context): string[] => segsFrom(c.req.path);

  // The MOVE/COPY Destination header: an absolute URL or an absolute path.
  const destOf = (c: Context): string[] | null => {
    const dest = c.req.header("Destination");
    if (!dest) return null;
    let pathname = dest;
    try {
      pathname = new URL(dest).pathname;
    } catch {
      /* already a path */
    }
    return segsFrom(pathname);
  };
  const overwriteOf = (c: Context) => (c.req.header("Overwrite") ?? "T").toUpperCase() !== "F";

  // Resolve segments → { spaceId, path } for a *user* principal; the first
  // segment may name a group space. Also returns the personal space + group list
  // for the whole-drive root listing.
  async function resolveUser(userSub: string, segs: string[]) {
    const spaces = await service.spaces(userSub);
    const personal = spaces.find((s) => s.kind === "personal");
    const personalId = personal?.id ?? (await service.personalSpace(userSub));
    const groups = spaces.filter((s) => s.kind === "group");
    if (segs.length) {
      const grp = groups.find((g) => g.name === segs[0]);
      if (grp) return { spaceId: grp.id, path: segs.slice(1).join("/"), personalId, groups };
    }
    return { spaceId: personalId, path: segs.join("/"), personalId, groups };
  }

  // Where a share is rooted: the space + base path the secret grants. For a file
  // share the base is the file's own path (a leaf, served directly).
  async function shareBase(share: VerifiedShare): Promise<{ spaceId: string; path: string }> {
    if (share.objectType === "file" && share.fileId) {
      const f = await service.getFile({ sub: share.createdBy }, share.fileId);
      const dir = (f.metadata.path as string) || "";
      return { spaceId: share.spaceId, path: dir ? `${dir}/${f.name}` : f.name };
    }
    return { spaceId: share.spaceId, path: share.objectType === "folder" ? share.path : "" };
  }

  // Map request segments to a concrete { spaceId, path } for the principal. For
  // a share, segments are relative to (and joined onto) its rooted base.
  async function locate(p: Principal, segs: string[]): Promise<{ spaceId: string; path: string }> {
    if (p.kind === "user") {
      const r = await resolveUser(p.sub, segs);
      return { spaceId: r.spaceId, path: r.path };
    }
    const base = await shareBase(p.share);
    const path = [base.path, ...segs].filter(Boolean).join("/");
    return { spaceId: base.spaceId, path };
  }

  // Parse `Authorization: Basic` into username + password (username is for audit only).
  function basicCreds(c: Context): { username: string; password: string } | null {
    const h = c.req.header("Authorization");
    if (!h?.startsWith("Basic ")) return null;
    let decoded = "";
    try {
      decoded = atob(h.slice(6));
    } catch {
      return null;
    }
    const i = decoded.indexOf(":");
    if (i < 0) return null;
    return { username: decoded.slice(0, i), password: decoded.slice(i + 1) };
  }

  // Username is attacker-controlled — strip control chars and cap length so it
  // can't inject into / flood the log.
  const sanitize = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 128);

  // Resolve Basic credentials to a principal. Verification is by the *password*
  // (app password, then share secret); the username never affects the decision —
  // on failure it's logged so a wrong-password attempt stays attributable.
  async function authPrincipal(c: Context): Promise<Principal | null> {
    const creds = basicCreds(c);
    if (!creds) return null;
    const sub = await service.verifyAppPassword(creds.password);
    if (sub) return { kind: "user", sub };
    const share = await service.verifyShare(creds.password);
    if (share) return { kind: "share", sub: share.createdBy, role: share.role, share };
    console.warn(`webdav auth failed user=${JSON.stringify(sanitize(creds.username))} ${c.req.method} ${c.req.path}`);
    return null;
  }

  const unauthorized = (c: Context) => {
    c.header("WWW-Authenticate", 'Basic realm="Canopy"');
    return c.body("Unauthorized", 401);
  };

  // Run a write handler: authenticate, reject read-only (viewer) share links,
  // then map domain errors to WebDAV status codes.
  const guard = (fn: (c: Context, p: Principal) => Promise<Response>) => async (c: Context) => {
    const p = await authPrincipal(c);
    if (!p) return unauthorized(c);
    if (isReadOnly(p)) return c.body("Forbidden", 403); // read-only share link
    try {
      return await fn(c, p);
    } catch (err) {
      if (err instanceof PermissionError) return c.body("Forbidden", 403);
      if (err instanceof NotFoundError) return c.body("Not found", 404);
      return c.body((err as Error).message, 409);
    }
  };

  app.on("OPTIONS", paths, (c) => {
    c.header("DAV", "1, 2");
    c.header("Allow", "OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, LOCK, UNLOCK");
    c.header("MS-Author-Via", "DAV");
    return c.body(null, 204);
  });

  app.on("PROPFIND", paths, async (c) => {
    const p = await authPrincipal(c);
    if (!p) return unauthorized(c);
    const segs = segsOf(c);
    const depth = c.req.header("Depth") ?? "1";
    const responses: string[] = [];

    // Whole-drive root for a user: personal space contents + each group space.
    if (p.kind === "user" && segs.length === 0) {
      responses.push(collectionXml(davHref([], true), "Canopy"));
      if (depth !== "0") {
        const { personalId, groups } = await resolveUser(p.sub, []);
        const listing = await service.list(p.sub, personalId, "");
        for (const folder of listing.folders) responses.push(collectionXml(davHref([folder], true), folder));
        for (const f of listing.files) responses.push(fileXml([f.name], f));
        for (const g of groups) responses.push(collectionXml(davHref([g.name], true), g.name));
      }
      return c.body(multistatus(responses), 207, XML);
    }

    const loc = await locate(p, segs);
    const file = await service.getByPath(p.sub, loc.spaceId, loc.path);
    if (file && file.version) {
      responses.push(fileXml(segs, file));
    } else if (depth === "0") {
      responses.push(collectionXml(davHref(segs, true), collectionName(segs, loc.path)));
    } else {
      const listing = await service.list(p.sub, loc.spaceId, loc.path);
      responses.push(collectionXml(davHref(segs, true), segs.length ? segs[segs.length - 1]! : loc.path ? base(loc.path) : listing.spaceName));
      for (const folder of listing.folders) responses.push(collectionXml(davHref([...segs, folder], true), folder));
      for (const f of listing.files) responses.push(fileXml([...segs, f.name], f));
    }
    return c.body(multistatus(responses), 207, XML);
  });

  // Finder sets properties (timestamps, Finder flags); we don't persist them but
  // must report success so saves go through.
  app.on("PROPPATCH", paths, async (c) => {
    const p = await authPrincipal(c);
    if (!p) return unauthorized(c);
    if (isReadOnly(p)) return c.body("Forbidden", 403);
    const href = davHref(segsOf(c), false);
    const body = multistatus([
      `<D:response><D:href>${href}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
    ]);
    return c.body(body, 207, XML);
  });

  // Locks aren't enforced — we mint a token so Finder will mount read-write.
  app.on("LOCK", paths, async (c) => {
    const p = await authPrincipal(c);
    if (!p) return unauthorized(c);
    const token = `opaquelocktoken:${crypto.randomUUID()}`;
    const href = davHref(segsOf(c), false);
    c.header("Lock-Token", `<${token}>`);
    const body =
      `<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>` +
      `<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>` +
      `<D:depth>infinity</D:depth><D:timeout>Second-3600</D:timeout>` +
      `<D:locktoken><D:href>${token}</D:href></D:locktoken>` +
      `<D:lockroot><D:href>${href}</D:href></D:lockroot>` +
      `</D:activelock></D:lockdiscovery></D:prop>`;
    return c.body(body, 200, XML);
  });

  app.on("UNLOCK", paths, async (c) => {
    const p = await authPrincipal(c);
    if (!p) return unauthorized(c);
    return c.body(null, 204);
  });

  app.on(
    "PUT",
    paths,
    guard(async (c, p) => {
      const segs = segsOf(c);
      if (segs.length === 0 && p.kind === "user") return c.body("Cannot write the root", 409);
      const name = segs[segs.length - 1] ?? "";
      if (name && isJunk(name)) return c.body(null, 201); // accept + discard macOS metadata
      const { spaceId, path } = await locate(p, segs);
      if (!path) return c.body("Cannot write a space", 403);
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const mime = c.req.header("Content-Type")?.split(";")[0]?.trim() || undefined;
      const { created } = await service.putByPath(spaceId, p.sub, path, bytes, mime);
      return c.body(null, created ? 201 : 204);
    }),
  );

  app.on(
    "MKCOL",
    paths,
    guard(async (c, p) => {
      const { spaceId, path } = await locate(p, segsOf(c));
      if (!path) return c.body("Cannot create a collection here", 403);
      if (await service.pathKind(p.sub, spaceId, path)) return c.body("Already exists", 405);
      await service.createFolder(spaceId, p.sub, path);
      return c.body(null, 201);
    }),
  );

  app.on(
    "DELETE",
    paths,
    guard(async (c, p) => {
      const segs = segsOf(c);
      if (segs.length && isJunk(segs[segs.length - 1]!)) return c.body(null, 204);
      const { spaceId, path } = await locate(p, segs);
      if (!path) return c.body("Cannot delete this", 403); // the root / a space
      await service.deleteByPath({ sub: p.sub }, spaceId, path);
      return c.body(null, 204);
    }),
  );

  app.on(
    "MOVE",
    paths,
    guard(async (c, p) => {
      const srcSegs = segsOf(c);
      const dstSegs = destOf(c);
      if (!dstSegs) return c.body("Destination required", 400);
      if (isJunk(srcSegs[srcSegs.length - 1] ?? "") || isJunk(dstSegs[dstSegs.length - 1] ?? "")) return c.body(null, 204);
      const src = await locate(p, srcSegs);
      const dst = await locate(p, dstSegs);
      if (!src.path || !dst.path) return c.body("Cannot move a space", 403);
      if (src.spaceId !== dst.spaceId) return c.body("Cannot move across spaces", 502);
      const { created } = await service.moveByPath({ sub: p.sub }, src.spaceId, src.path, dst.path, overwriteOf(c));
      return c.body(null, created ? 201 : 204);
    }),
  );

  app.on(
    "COPY",
    paths,
    guard(async (c, p) => {
      const srcSegs = segsOf(c);
      const dstSegs = destOf(c);
      if (!dstSegs) return c.body("Destination required", 400);
      if (isJunk(srcSegs[srcSegs.length - 1] ?? "") || isJunk(dstSegs[dstSegs.length - 1] ?? "")) return c.body(null, 204);
      const src = await locate(p, srcSegs);
      const dst = await locate(p, dstSegs);
      if (!src.path || !dst.path) return c.body("Cannot copy a space", 403);
      if (src.spaceId !== dst.spaceId) return c.body("Cannot copy across spaces", 502);
      const { created } = await service.copyByPath({ sub: p.sub }, src.spaceId, src.path, dst.path, overwriteOf(c));
      return c.body(null, created ? 201 : 204);
    }),
  );

  const serveFile = async (c: Context, body: boolean) => {
    const p = await authPrincipal(c);
    if (!p) return unauthorized(c);
    const { spaceId, path } = await locate(p, segsOf(c));
    const file = await service.getByPath(p.sub, spaceId, path);
    if (!file?.version || file.version.source !== "blob" || !file.version.blobKey) return c.body("Not found", 404);
    c.header("Content-Type", file.version.mime ?? mimeFor(file.name));
    c.header("Content-Length", String(file.version.size));
    if (!body) return c.body(null, 200);
    const stream = await blobs.get(file.version.blobKey);
    if (!stream) return c.body("Not found", 404);
    return c.body(stream);
  };

  app.on("HEAD", paths, (c) => serveFile(c, false));
  app.get("/dav", (c) => serveFile(c, true));
  app.get("/dav/*", (c) => serveFile(c, true));
}

/** Last segment of a virtual path (its display name). */
const base = (path: string) => path.split("/").pop() ?? path;

/** Best-effort display name for a collection at `segs`/`path` when not listing it. */
const collectionName = (segs: string[], path: string) =>
  segs.length ? segs[segs.length - 1]! : path ? base(path) : "Shared";
