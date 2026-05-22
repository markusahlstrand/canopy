import type { Hono, Context } from "hono";
import type { BlobStore, FileService, FileWithVersion } from "@canopy/store";

/**
 * Read-only WebDAV (RFC 4918, class 1) so the drive can be mounted in Finder /
 * Explorer over `…/dav`. Auth is HTTP Basic with an **app password** (Finder
 * can't do OIDC). The mount root lists the personal space's contents plus each
 * group space as a top-level collection.
 *
 * Read-only for now: OPTIONS, PROPFIND, GET, HEAD. Writes (PUT/MKCOL/MOVE/LOCK)
 * come later.
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

/** Build a /dav href from path segments; collections get a trailing slash. */
function davHref(segs: string[], isCollection: boolean): string {
  const enc = segs.map(encodeURIComponent).join("/");
  return `/dav/${enc}${isCollection && enc ? "/" : enc ? "" : ""}`;
}

function collectionXml(href: string, name: string): string {
  return (
    `<D:response><D:href>${href}</D:href><D:propstat><D:prop>` +
    `<D:resourcetype><D:collection/></D:resourcetype>` +
    `<D:displayname>${xmlEscape(name)}</D:displayname>` +
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
    `<D:getcontenttype>${xmlEscape(ctype)}</D:getcontenttype>` +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  );
}

const multistatus = (responses: string[]) =>
  `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${responses.join("")}</D:multistatus>`;

export function registerWebdav(app: Hono, deps: { service: FileService; blobs: BlobStore }): void {
  const { service, blobs } = deps;
  const paths = ["/dav", "/dav/*"];

  const segsOf = (c: Context): string[] => {
    const raw = c.req.path.replace(/^\/dav\/?/, "");
    return raw ? raw.split("/").filter(Boolean).map(decodeURIComponent) : [];
  };

  // Resolve segments → { spaceId, path }; the first segment may name a group space.
  async function resolve(userSub: string, segs: string[]) {
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

  async function authUser(c: Context): Promise<string | null> {
    const h = c.req.header("Authorization");
    if (!h?.startsWith("Basic ")) return null;
    let decoded = "";
    try {
      decoded = atob(h.slice(6));
    } catch {
      return null;
    }
    const pass = decoded.slice(decoded.indexOf(":") + 1);
    return service.verifyAppPassword(pass);
  }
  const unauthorized = (c: Context) => {
    c.header("WWW-Authenticate", 'Basic realm="Canopy"');
    return c.body("Unauthorized", 401);
  };

  app.on("OPTIONS", paths, (c) => {
    c.header("DAV", "1");
    c.header("Allow", "OPTIONS, PROPFIND, GET, HEAD");
    c.header("MS-Author-Via", "DAV");
    return c.body(null, 204);
  });

  app.on("PROPFIND", paths, async (c) => {
    const userSub = await authUser(c);
    if (!userSub) return unauthorized(c);
    const segs = segsOf(c);
    const depth = c.req.header("Depth") ?? "1";
    const responses: string[] = [];

    if (segs.length === 0) {
      responses.push(collectionXml(davHref([], true), "Canopy"));
      if (depth !== "0") {
        const { personalId, groups } = await resolve(userSub, []);
        const listing = await service.list(userSub, personalId, "");
        for (const folder of listing.folders) responses.push(collectionXml(davHref([folder], true), folder));
        for (const f of listing.files) responses.push(fileXml([f.name], f));
        for (const g of groups) responses.push(collectionXml(davHref([g.name], true), g.name));
      }
      return c.body(multistatus(responses), 207, { "Content-Type": "application/xml; charset=utf-8" });
    }

    const { spaceId, path } = await resolve(userSub, segs);
    const file = await service.getByPath(userSub, spaceId, path);
    if (file && file.version) {
      responses.push(fileXml(segs, file));
    } else {
      responses.push(collectionXml(davHref(segs, true), segs[segs.length - 1]!));
      if (depth !== "0") {
        const listing = await service.list(userSub, spaceId, path);
        for (const folder of listing.folders) responses.push(collectionXml(davHref([...segs, folder], true), folder));
        for (const f of listing.files) responses.push(fileXml([...segs, f.name], f));
      }
    }
    return c.body(multistatus(responses), 207, { "Content-Type": "application/xml; charset=utf-8" });
  });

  const serveFile = async (c: Context, body: boolean) => {
    const userSub = await authUser(c);
    if (!userSub) return unauthorized(c);
    const segs = segsOf(c);
    const { spaceId, path } = await resolve(userSub, segs);
    const file = await service.getByPath(userSub, spaceId, path);
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
