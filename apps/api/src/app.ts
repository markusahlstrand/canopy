import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { StorageConnector } from "@canopy/core";
import type { AuthConfig } from "./auth/config";
import { getSessionUser } from "./auth/routes";
import { scopedConnector, driveScope } from "./scoped";

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

/**
 * Portable Canopy API. Runs on any runtime Hono supports (Node, Workers, …).
 * Storage connectors are injected, keyed by mount name, so the same app works
 * over local FS, R2, etc. — and a single deployment can expose several mounts
 * (e.g. the user's drive plus a read-only `docs` mount).
 */
export function createApp(
  connectors: Record<string, StorageConnector>,
  options: { auth?: Hono; authConfig?: AuthConfig | null } = {},
) {
  const app = new Hono();

  app.use("/api/*", cors());

  if (options.auth) app.route("/api/auth", options.auth);

  /**
   * Resolve the connector for a request's mount, scoped to the caller's drive:
   * each signed-in user gets their own `users/<sub>` folder; anonymous sees the
   * shared `demo` folder. The read-only `docs` mount is shared (not scoped).
   */
  async function connectorFor(c: Context): Promise<StorageConnector | undefined> {
    const mount = c.req.query("mount") ?? "local";
    if (mount === "docs") return connectors.docs;
    // The drive: signed-in users get their own folder; anonymous gets the demo.
    const base = connectors.local;
    if (!base) return undefined;
    const user = await getSessionUser(c, options.authConfig ?? null);
    if (user) return scopedConnector(base, driveScope(user.sub));
    return connectors.demo ?? scopedConnector(base, "demo");
  }

  app.get("/api/health", (c) => c.json({ ok: true, mounts: Object.keys(connectors) }));

  app.get("/api/files", async (c) => {
    const connector = await connectorFor(c);
    if (!connector) return c.json({ error: "unknown mount" }, 404);
    const path = c.req.query("path") ?? "";
    try {
      return c.json(await connector.list(path));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.get("/api/file", async (c) => {
    const connector = await connectorFor(c);
    if (!connector) return c.json({ error: "unknown mount" }, 404);
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path required" }, 400);
    const entry = await connector.stat(path);
    if (!entry || entry.kind === "folder") return c.json({ error: "not found" }, 404);
    const stream = await connector.read(path);
    c.header("Content-Type", mimeFor(entry.name));
    c.header("Content-Disposition", `inline; filename="${encodeURIComponent(entry.name)}"`);
    return c.body(stream);
  });

  // Write (create/overwrite) a single file from the raw request body.
  app.put("/api/file", async (c) => {
    const connector = await connectorFor(c);
    if (!connector) return c.json({ error: "unknown mount" }, 404);
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path required" }, 400);
    try {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      return c.json(await connector.write(path, bytes), 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.delete("/api/file", async (c) => {
    const connector = await connectorFor(c);
    if (!connector) return c.json({ error: "unknown mount" }, 404);
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path required" }, 400);
    try {
      await connector.remove(path);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // Multipart upload of one or more files into a destination directory.
  app.post("/api/upload", async (c) => {
    const connector = await connectorFor(c);
    if (!connector) return c.json({ error: "unknown mount" }, 404);
    const dir = c.req.query("path") ?? "";
    try {
      const body = await c.req.parseBody({ all: true });
      const field = body["file"];
      const files = (Array.isArray(field) ? field : [field]).filter((f): f is File => f instanceof File);
      if (files.length === 0) return c.json({ error: "no files" }, 400);
      const items = [];
      for (const file of files) {
        const dest = [dir, file.name].filter(Boolean).join("/");
        const bytes = new Uint8Array(await file.arrayBuffer());
        items.push(await connector.write(dest, bytes));
      }
      return c.json({ items }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  return app;
}
