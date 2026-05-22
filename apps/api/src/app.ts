import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { StorageConnector } from "@canopy/core";
import {
  BlobHashMismatchError,
  BlobMissingError,
  NotFoundError,
  PermissionError,
  type BlobStore,
  type FileService,
} from "@canopy/store";
import type { AuthConfig } from "./auth/config";
import { getSessionUser } from "./auth/routes";

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

function mimeFor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

/** The DB-backed drive: a file service plus the blob store for streaming downloads. */
export interface DriveDeps {
  service: FileService;
  blobs: BlobStore;
}

export interface AppDeps {
  auth?: Hono;
  authConfig?: AuthConfig | null;
  /** Read-only mounts (docs, demo) served from a StorageConnector — NOT the drive. */
  readonlyMounts?: Record<string, StorageConnector>;
  /** The user's drive, backed by @canopy/store (D1/libsql + R2/fs). */
  drive?: DriveDeps;
}

/**
 * Portable Canopy API. The **drive** is the DB-backed file service from
 * @canopy/store (files as records, content-addressed blobs, versions); the
 * read-only `docs`/`demo` mounts are still plain StorageConnectors over GitHub.
 * Tenant = the signed-in user's `sub`.
 */
export function createApp(deps: AppDeps) {
  const app = new Hono();
  const { authConfig = null, readonlyMounts = {}, drive } = deps;

  app.use("/api/*", cors());
  if (deps.auth) app.route("/api/auth", deps.auth);

  app.get("/api/health", (c) =>
    c.json({ ok: true, drive: !!drive, mounts: Object.keys(readonlyMounts) }),
  );

  // The caller: sub + email (email feeds pending-invite resolution). When auth
  // isn't configured (dev / anonymous demo) the drive runs as a shared "demo"
  // user; when auth IS configured, a session is required.
  async function callerOf(c: Context): Promise<{ sub: string; email: string } | null> {
    if (!authConfig) return { sub: "demo", email: "" };
    const user = await getSessionUser(c, authConfig);
    return user ? { sub: user.sub, email: user.email ?? "" } : null;
  }

  // The target space for an upload/list/create: `?space=` or the caller's personal space.
  async function resolveSpace(c: Context, sub: string): Promise<string> {
    return c.req.query("space") ?? (await drive!.service.personalSpace(sub));
  }

  // Map domain errors to HTTP. Anything else bubbles as a 500.
  async function handle(c: Context, fn: () => Promise<Response>): Promise<Response> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PermissionError) return c.json({ error: "forbidden" }, 403);
      if (err instanceof NotFoundError) return c.json({ error: "not found" }, 404);
      if (err instanceof BlobMissingError) return c.json({ error: "blob not uploaded" }, 409);
      if (err instanceof BlobHashMismatchError) return c.json({ error: err.message }, 422);
      return c.json({ error: (err as Error).message }, 400);
    }
  }

  // ── read-only mounts (docs/demo) ────────────────────────────────────────────
  // Kept on the legacy path-based shape so the Docs plugin works unchanged.

  app.get("/api/file", async (c) => {
    const mount = c.req.query("mount");
    const connector = mount ? readonlyMounts[mount] : undefined;
    if (!connector) return c.json({ error: "unknown mount" }, 404);
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path required" }, 400);
    const entry = await connector.stat(path);
    if (!entry || entry.kind === "folder") return c.json({ error: "not found" }, 404);
    c.header("Content-Type", mimeFor(entry.name));
    c.header("Content-Disposition", `inline; filename="${encodeURIComponent(entry.name)}"`);
    return c.body(await connector.read(path));
  });

  // ── the drive ───────────────────────────────────────────────────────────────

  // Drive routes need a configured drive + a caller; this wraps both.
  const driveRoute = (fn: (c: Context, caller: { sub: string; email: string }) => Promise<Response>) => (c: Context) =>
    handle(c, async () => {
      if (!drive) return c.json({ error: "no drive configured" }, 404);
      const caller = await callerOf(c);
      if (!caller) return c.json({ error: "unauthorized" }, 401);
      return fn(c, caller);
    });

  // List: a read-only mount when `?mount=` is set; `?shared=1` for files shared
  // with me; otherwise a folder of a space (`?space=` + `?path=`).
  app.get("/api/files", (c) =>
    handle(c, async () => {
      const mount = c.req.query("mount");
      if (mount) {
        const connector = readonlyMounts[mount];
        if (!connector) return c.json({ error: "unknown mount" }, 404);
        return c.json(await connector.list(c.req.query("path") ?? ""));
      }
      if (!drive) return c.json({ error: "no drive configured" }, 404);
      const caller = await callerOf(c);
      if (!caller) return c.json({ error: "unauthorized" }, 401);
      if (c.req.query("shared") != null) {
        return c.json({ path: "", files: await drive.service.listSharedWithMe(caller.sub), folders: [] });
      }
      const space = await resolveSpace(c, caller.sub);
      return c.json(await drive.service.list(caller.sub, space, c.req.query("path") ?? ""));
    }),
  );

  // Spaces the caller can see (for the space switcher).
  app.get("/api/spaces", driveRoute(async (_c, caller) => _c.json(await drive!.service.spaces(caller.sub))));

  // Create a shared (group) space — e.g. a family.
  app.post("/api/spaces", driveRoute(async (c, caller) => {
    const { name } = await c.req.json<{ name: string }>();
    if (!name) return c.json({ error: "name required" }, 400);
    return c.json(await drive!.service.createSpace(caller, name), 201);
  }));

  app.get("/api/spaces/:id/members", driveRoute(async (c, caller) =>
    c.json(await drive!.service.spaceMembers(caller, c.req.param("id")!)),
  ));

  // Add a member by email (they must have signed in once). Requires space owner.
  app.post("/api/spaces/:id/members", driveRoute(async (c, caller) => {
    const { email, role } = await c.req.json<{ email: string; role: "owner" | "editor" | "viewer" }>();
    if (!email || !role) return c.json({ error: "email and role required" }, 400);
    return c.json(await drive!.service.addSpaceMember(caller, c.req.param("id")!, email, role), 201);
  }));

  app.delete("/api/spaces/:id/members", driveRoute(async (c, caller) => {
    const { sub } = await c.req.json<{ sub: string }>();
    if (!sub) return c.json({ error: "sub required" }, 400);
    await drive!.service.removeSpaceMember(caller, c.req.param("id")!, sub);
    return c.json({ ok: true });
  }));

  // Pin/unpin a space into My Drive (the merged vs. switcher preference).
  app.patch("/api/spaces/:id/prefs", driveRoute(async (c, caller) => {
    const { mounted } = await c.req.json<{ mounted: boolean }>();
    await drive!.service.setSpaceMounted(caller, c.req.param("id")!, !!mounted);
    return c.json({ ok: true });
  }));

  // Dedup check before uploading. `exists` → skip straight to creating the file.
  app.post("/api/uploads/prepare", driveRoute(async (c, caller) => {
    const { hash } = await c.req.json<{ hash: string; size?: number }>();
    if (!hash) return c.json({ error: "hash required" }, 400);
    const space = await resolveSpace(c, caller.sub);
    const res = await drive!.service.prepareUpload(space, caller.sub, hash);
    return c.json(res.exists ? { exists: true } : { exists: false, upload: { method: "PUT", url: `/api/uploads/${hash}` } });
  }));

  // Stream bytes for a new blob; the token is the claimed hash, re-verified server-side.
  app.put("/api/uploads/:token", driveRoute(async (c, caller) => {
    const space = await resolveSpace(c, caller.sub);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const res = await drive!.service.commitUpload(space, caller.sub, c.req.param("token")!, bytes);
    return c.json({ hash: res.hash, size: res.size }, 201);
  }));

  // Create a file record + first version (the blob must be prepared/uploaded).
  app.post("/api/files", driveRoute(async (c, caller) => {
    const body = await c.req.json<{ name: string; hash: string; mime?: string; path?: string; metadata?: Record<string, unknown> }>();
    if (!body.name || !body.hash) return c.json({ error: "name and hash required" }, 400);
    const space = await resolveSpace(c, caller.sub);
    return c.json(await drive!.service.createFile(space, caller.sub, body), 201);
  }));

  app.get("/api/files/:id", driveRoute(async (c, caller) =>
    c.json(await drive!.service.getFile(caller, c.req.param("id")!)),
  ));

  // Download bytes. `?embed=true` would project metadata into the file where the
  // format supports it; today it passes through (see README).
  app.get("/api/files/:id/content", driveRoute(async (c, caller) => {
    const file = await drive!.service.getFile(caller, c.req.param("id")!);
    if (!file.version) return c.json({ error: "no content" }, 404);
    // Managed blobs stream from the blob store; external (indexed) sources are
    // read through their connector — wired with the connections API.
    if (file.version.source !== "blob" || !file.version.blobKey) {
      return c.json({ error: "external content read not yet wired" }, 501);
    }
    const stream = await drive!.blobs.get(file.version.blobKey);
    if (!stream) return c.json({ error: "blob missing" }, 404);
    c.header("Content-Type", file.version.mime ?? mimeFor(file.name));
    c.header("Content-Disposition", `inline; filename="${encodeURIComponent(file.name)}"`);
    return c.body(stream);
  }));

  // Metadata edit — never creates a new version.
  app.patch("/api/files/:id/metadata", driveRoute(async (c, caller) => {
    const patch = await c.req.json<Record<string, unknown>>();
    return c.json(await drive!.service.patchMetadata(caller, c.req.param("id")!, patch));
  }));

  // New content version — never alters metadata. Dedup applies to its blob.
  app.post("/api/files/:id/versions", driveRoute(async (c, caller) => {
    const body = await c.req.json<{ hash: string; mime?: string }>();
    if (!body.hash) return c.json({ error: "hash required" }, 400);
    return c.json(await drive!.service.addVersion(caller, c.req.param("id")!, body));
  }));

  app.delete("/api/files/:id", driveRoute(async (c, caller) => {
    await drive!.service.deleteFile(caller, c.req.param("id")!);
    return c.json({ ok: true });
  }));

  // ── per-file sharing (grants) ───────────────────────────────────────────────

  app.get("/api/files/:id/grants", driveRoute(async (c, caller) =>
    c.json(await drive!.service.listGrants(caller, c.req.param("id")!)),
  ));

  app.post("/api/files/:id/grants", driveRoute(async (c, caller) => {
    const body = await c.req.json<{ subjectType: "user" | "space" | "email"; subjectId: string; role: "owner" | "editor" | "viewer" }>();
    if (!body.subjectType || !body.subjectId || !body.role) return c.json({ error: "subjectType, subjectId, role required" }, 400);
    // Share-by-email: if the invitee already exists, store a user grant; else a pending email invite.
    let grant = body;
    if (body.subjectType === "email") {
      const user = await drive!.service.resolveEmail(body.subjectId);
      if (user) grant = { ...body, subjectType: "user", subjectId: user.sub };
    }
    await drive!.service.shareGrant(caller, c.req.param("id")!, grant);
    return c.json({ ok: true }, 201);
  }));

  app.delete("/api/files/:id/grants", driveRoute(async (c, caller) => {
    const body = await c.req.json<{ subjectType: "user" | "space" | "email"; subjectId: string; role: "owner" | "editor" | "viewer" }>();
    await drive!.service.unshareGrant(caller, c.req.param("id")!, body);
    return c.json({ ok: true });
  }));

  return app;
}
