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

  // The signed-in user's id is the tenant. When auth isn't configured at all
  // (dev / anonymous demo) the drive runs under a shared "demo" tenant so it's
  // usable without login; when auth IS configured, a session is required.
  async function tenantOf(c: Context): Promise<string | null> {
    if (!authConfig) return "demo";
    const user = await getSessionUser(c, authConfig);
    return user?.sub ?? null;
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

  // List: a read-only mount when `?mount=` is set, otherwise the user's drive
  // folder (`?path=` is the virtual folder). Drive listing requires auth.
  app.get("/api/files", (c) =>
    handle(c, async () => {
      const mount = c.req.query("mount");
      if (mount) {
        const connector = readonlyMounts[mount];
        if (!connector) return c.json({ error: "unknown mount" }, 404);
        return c.json(await connector.list(c.req.query("path") ?? ""));
      }
      if (!drive) return c.json({ error: "no drive configured" }, 404);
      const tenant = await tenantOf(c);
      if (!tenant) return c.json({ error: "unauthorized" }, 401);
      return c.json(await drive.service.list(tenant, tenant, c.req.query("path") ?? ""));
    }),
  );

  // Dedup check before uploading. `exists` → skip straight to creating the file.
  app.post("/api/uploads/prepare", (c) =>
    handle(c, async () => {
      if (!drive) return c.json({ error: "no drive configured" }, 404);
      const tenant = await tenantOf(c);
      if (!tenant) return c.json({ error: "unauthorized" }, 401);
      const { hash } = await c.req.json<{ hash: string; size?: number }>();
      if (!hash) return c.json({ error: "hash required" }, 400);
      const res = await drive.service.prepareUpload(tenant, hash);
      return c.json(res.exists ? { exists: true } : { exists: false, upload: { method: "PUT", url: `/api/uploads/${hash}` } });
    }),
  );

  // Stream bytes for a new blob; the token is the claimed hash, re-verified server-side.
  app.put("/api/uploads/:token", (c) =>
    handle(c, async () => {
      if (!drive) return c.json({ error: "no drive configured" }, 404);
      const tenant = await tenantOf(c);
      if (!tenant) return c.json({ error: "unauthorized" }, 401);
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const res = await drive.service.commitUpload(tenant, c.req.param("token"), bytes);
      return c.json({ hash: res.hash, size: res.size }, 201);
    }),
  );

  // Create a file record + first version (the blob must be prepared/uploaded).
  app.post("/api/files", (c) =>
    handle(c, async () => {
      if (!drive) return c.json({ error: "no drive configured" }, 404);
      const tenant = await tenantOf(c);
      if (!tenant) return c.json({ error: "unauthorized" }, 401);
      const body = await c.req.json<{ name: string; hash: string; mime?: string; path?: string; metadata?: Record<string, unknown> }>();
      if (!body.name || !body.hash) return c.json({ error: "name and hash required" }, 400);
      return c.json(await drive.service.createFile(tenant, tenant, body), 201);
    }),
  );

  app.get("/api/files/:id", (c) =>
    handle(c, async () => {
      if (!drive) return c.json({ error: "no drive configured" }, 404);
      const tenant = await tenantOf(c);
      if (!tenant) return c.json({ error: "unauthorized" }, 401);
      return c.json(await drive.service.getFile(tenant, tenant, c.req.param("id")));
    }),
  );

  // Download bytes. `?embed=true` would project metadata into the file where the
  // format supports it; today it passes through (see README).
  app.get("/api/files/:id/content", (c) =>
    handle(c, async () => {
      if (!drive) return c.json({ error: "no drive configured" }, 404);
      const tenant = await tenantOf(c);
      if (!tenant) return c.json({ error: "unauthorized" }, 401);
      const file = await drive.service.getFile(tenant, tenant, c.req.param("id"));
      if (!file.version) return c.json({ error: "no content" }, 404);
      // Managed blobs stream from the blob store; external (indexed) sources are
      // read through their connector — wired with the connections API.
      if (file.version.source !== "blob" || !file.version.blobKey) {
        return c.json({ error: "external content read not yet wired" }, 501);
      }
      const stream = await drive.blobs.get(file.version.blobKey);
      if (!stream) return c.json({ error: "blob missing" }, 404);
      c.header("Content-Type", file.version.mime ?? mimeFor(file.name));
      c.header("Content-Disposition", `inline; filename="${encodeURIComponent(file.name)}"`);
      return c.body(stream);
    }),
  );

  // Metadata edit — never creates a new version.
  app.patch("/api/files/:id/metadata", (c) =>
    handle(c, async () => {
      if (!drive) return c.json({ error: "no drive configured" }, 404);
      const tenant = await tenantOf(c);
      if (!tenant) return c.json({ error: "unauthorized" }, 401);
      const patch = await c.req.json<Record<string, unknown>>();
      return c.json(await drive.service.patchMetadata(tenant, tenant, c.req.param("id"), patch));
    }),
  );

  // New content version — never alters metadata. Dedup applies to its blob.
  app.post("/api/files/:id/versions", (c) =>
    handle(c, async () => {
      if (!drive) return c.json({ error: "no drive configured" }, 404);
      const tenant = await tenantOf(c);
      if (!tenant) return c.json({ error: "unauthorized" }, 401);
      const body = await c.req.json<{ hash: string; mime?: string }>();
      if (!body.hash) return c.json({ error: "hash required" }, 400);
      return c.json(await drive.service.addVersion(tenant, tenant, c.req.param("id"), body));
    }),
  );

  app.delete("/api/files/:id", (c) =>
    handle(c, async () => {
      if (!drive) return c.json({ error: "no drive configured" }, 404);
      const tenant = await tenantOf(c);
      if (!tenant) return c.json({ error: "unauthorized" }, 401);
      await drive.service.deleteFile(tenant, tenant, c.req.param("id"));
      return c.json({ ok: true });
    }),
  );

  return app;
}
