import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { scopedCache, type CacheStore, type StorageConnector } from "@canopy/core";
import {
  BlobHashMismatchError,
  BlobMissingError,
  NotFoundError,
  PermissionError,
  type BlobStore,
  type Caller,
  type FileService,
} from "@canopy/store";
import type { AuthConfig } from "./auth/config";
import { getSessionUser } from "./auth/routes";
import { registerWebdav } from "./webdav";
import type { ServerDataSource } from "./data-sources";
import { decryptString, encryptString } from "./crypto";

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

/**
 * Data-source plugins (e.g. GitHub) that feed the tasks/calendar host plugins.
 * Each user configures a source via its settings (repo + optional token, stored
 * encrypted per-user); `demoDefaults` is the env-provided fallback config shown to
 * everyone (incl. anonymous) so the public demo works without sign-in. `cache`
 * memoizes upstream responses to respect rate limits; `secret` encrypts stored
 * secret fields at rest.
 */
export interface DataSourceDeps {
  plugins?: ServerDataSource[];
  demoDefaults?: Record<string, Record<string, string>>;
  cache?: CacheStore;
  secret?: string;
}

export interface AppDeps {
  auth?: Hono;
  authConfig?: AuthConfig | null;
  /** Read-only mounts (documentation, demo) served from a StorageConnector — NOT the drive. */
  readonlyMounts?: Record<string, StorageConnector>;
  /** The user's drive, backed by @canopy/store (D1/libsql + R2/fs). */
  drive?: DriveDeps;
  /** Connected data-source plugins feeding tasks/calendar. */
  dataSources?: DataSourceDeps;
}

/**
 * Plugins a user starts with before they customize anything. Documentation is a
 * default only for signed-out / anonymous visitors (incl. demo mode, where auth
 * is off and it doubles as the landing page); signed-in users add it from the store.
 */
const DEFAULT_PLUGINS = ["calendar", "tasks"];
const ANON_DEFAULT_PLUGINS = ["documentation", ...DEFAULT_PLUGINS];

/**
 * Portable Canopy API. The **drive** is the DB-backed file service from
 * @canopy/store (files as records, content-addressed blobs, versions); the
 * read-only `documentation`/`demo` mounts are still plain StorageConnectors over GitHub.
 * Tenant = the signed-in user's `sub`.
 */
export function createApp(deps: AppDeps) {
  const app = new Hono();
  const { authConfig = null, readonlyMounts = {}, drive, dataSources } = deps;

  app.use("/api/*", cors());
  if (deps.auth) app.route("/api/auth", deps.auth);

  app.get("/api/health", (c) =>
    c.json({ ok: true, drive: !!drive, mounts: Object.keys(readonlyMounts) }),
  );

  // The caller: sub + email (email feeds pending-invite resolution). When auth
  // isn't configured (dev / anonymous demo) the drive runs as a shared "demo"
  // user; when auth IS configured, a session is required.
  async function callerOf(c: Context): Promise<Caller | null> {
    if (!authConfig) return { sub: "demo", email: "", emailVerified: false };
    const user = await getSessionUser(c, authConfig);
    if (!user) return null;
    // Backfill the directory from the session's id_token claims. The login
    // callback already does this, but a long-lived session (or a reset dev DB)
    // can outlive the row — without this the member/sharing UI falls back to the
    // raw sub. INSERT-OR-IGNORE makes it a no-op once the row exists.
    if (drive) await drive.service.ensureUser(user);
    return { sub: user.sub, email: user.email ?? "", emailVerified: !!user.emailVerified };
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

  // ── read-only mounts (documentation/demo) ───────────────────────────────────
  // Kept on the legacy path-based shape so the Documentation plugin works unchanged.

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
  const driveRoute = (fn: (c: Context, caller: Caller) => Promise<Response>) => (c: Context) =>
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
      if (c.req.query("trash") != null) {
        return c.json({ path: "", files: await drive.service.listTrash(caller.sub), folders: [] });
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

  // Invite links — single-use, role baked in. Owner mints / lists / revokes.
  app.post("/api/spaces/:id/invites", driveRoute(async (c, caller) => {
    const { role } = await c.req.json<{ role: "owner" | "editor" | "viewer" }>();
    if (!role) return c.json({ error: "role required" }, 400);
    return c.json(await drive!.service.createSpaceInvite(caller, c.req.param("id")!, role), 201);
  }));

  app.get("/api/spaces/:id/invites", driveRoute(async (c, caller) =>
    c.json(await drive!.service.spaceInvites(caller, c.req.param("id")!)),
  ));

  app.delete("/api/spaces/:id/invites/:token", driveRoute(async (c, caller) => {
    await drive!.service.revokeSpaceInvite(caller, c.req.param("id")!, c.req.param("token")!);
    return c.json({ ok: true });
  }));

  // Pending email invites awaiting the caller (invites bound to their address that
  // haven't resolved yet) — powers the in-app invites banner. Registered before the
  // `:token` routes so "pending" isn't matched as a token.
  app.get("/api/invites/pending", driveRoute(async (c, caller) =>
    c.json(await drive!.service.pendingInvites(caller)),
  ));

  // Claim all pending email invites for the caller's (verified) address.
  app.post("/api/invites/pending/accept", driveRoute(async (c, caller) =>
    c.json(await drive!.service.acceptPendingInvites(caller)),
  ));

  // Opening an invite link: preview needs no sign-in (so recipients see what
  // they're joining); accepting does (the signed-in account becomes the member).
  app.get("/api/invites/:token", (c) =>
    handle(c, async () => {
      if (!drive) return c.json({ error: "no drive configured" }, 404);
      return c.json(await drive.service.inviteInfo(c.req.param("token")!));
    }),
  );

  app.post("/api/invites/:token/accept", driveRoute(async (c, caller) =>
    c.json(await drive!.service.acceptSpaceInvite(caller, c.req.param("token")!)),
  ));

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

  // Create an (empty) folder in a space.
  app.post("/api/folders", driveRoute(async (c, caller) => {
    const { path } = await c.req.json<{ path: string }>();
    if (!path) return c.json({ error: "path required" }, 400);
    const space = await resolveSpace(c, caller.sub);
    return c.json(await drive!.service.createFolder(space, caller.sub, path), 201);
  }));

  // Lightweight stats for the dashboard (file count + bytes used in a space).
  app.get("/api/overview", driveRoute(async (c, caller) => {
    const space = await resolveSpace(c, caller.sub);
    return c.json(await drive!.service.overview(caller.sub, space));
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

  // Soft-delete (→ Trash) by default; `?permanent=1` purges the file + its content.
  app.delete("/api/files/:id", driveRoute(async (c, caller) => {
    const id = c.req.param("id")!;
    if (c.req.query("permanent") != null) await drive!.service.purgeFile(caller, id);
    else await drive!.service.deleteFile(caller, id);
    return c.json({ ok: true });
  }));

  // Restore a file from Trash.
  app.post("/api/files/:id/restore", driveRoute(async (c, caller) => {
    await drive!.service.restoreFile(caller, c.req.param("id")!);
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

  // ── app passwords (for WebDAV / Basic-auth clients) ─────────────────────────

  app.get("/api/app-passwords", driveRoute(async (_c, caller) => _c.json(await drive!.service.listAppPasswords(caller.sub))));

  // Returns the plaintext token ONCE — it isn't recoverable later.
  app.post("/api/app-passwords", driveRoute(async (c, caller) => {
    const { name } = await c.req.json<{ name?: string }>();
    const { id, token } = await drive!.service.createAppPassword(caller.sub, name ?? "Device");
    return c.json({ id, token }, 201);
  }));

  app.delete("/api/app-passwords/:id", driveRoute(async (c, caller) => {
    await drive!.service.deleteAppPassword(caller.sub, c.req.param("id")!);
    return c.json({ ok: true });
  }));

  // ── plugin data sources (tasks / calendar) ──────────────────────────────────
  // A source's config is per-user (stored encrypted); `demoDefaults` is the
  // public fallback shown to everyone so the logged-out demo still has data.
  // The adapter owns its own caching (TTL) via the scoped cache it's handed.
  const sourcePlugins = dataSources?.plugins ?? [];
  const findSource = (id: string) => sourcePlugins.find((p) => p.id === id);

  /**
   * The caller's saved config for a plugin (secrets decrypted), or the demo
   * default — plus a cache `scope` that isolates this caller's cached data from
   * everyone else's (so a private repo's data can't leak across users).
   */
  async function resolveConfig(
    c: Context,
    pluginId: string,
  ): Promise<{ config: Record<string, string>; own: boolean; scope: string } | null> {
    const src = findSource(pluginId);
    if (!src) return null;
    const caller = await callerOf(c);
    if (caller && drive) {
      const raw = await drive.service.getPluginSettings(caller.sub, pluginId);
      if (raw) {
        const stored = JSON.parse(raw) as Record<string, string>;
        const config: Record<string, string> = {};
        for (const f of src.configFields) {
          const v = stored[f.key];
          if (v == null) continue;
          if (f.type === "secret") {
            const dec = dataSources?.secret ? await decryptString(dataSources.secret, v) : null;
            if (dec != null) config[f.key] = dec;
          } else {
            config[f.key] = v;
          }
        }
        // Use the caller's own config only if every required field is present.
        if (src.configFields.filter((f) => f.required).every((f) => config[f.key]))
          return { config, own: true, scope: `u:${caller.sub}:${pluginId}` };
      }
    }
    const demo = dataSources?.demoDefaults?.[pluginId];
    return demo ? { config: demo, own: false, scope: `demo:${pluginId}` } : null;
  }

  // Build a source's providers, handing the adapter a cache scoped to this caller.
  function providersFor(pluginId: string, resolved: { config: Record<string, string>; scope: string }) {
    const src = findSource(pluginId);
    if (!src) return {};
    const cache = dataSources?.cache ? scopedCache(dataSources.cache, resolved.scope) : undefined;
    return src.build(resolved.config, { cache });
  }

  // What's connected for the caller, so the client can show live vs. configure.
  app.get("/api/integrations", (c) =>
    handle(c, async () => {
      const out: Record<string, unknown> = { sources: sourcePlugins.map((p) => p.id) };
      const gh = await resolveConfig(c, "github");
      out.sourceId = gh ? "github" : null;
      out.repo = gh?.config.repo ?? null;
      out.usingDefault = gh ? !gh.own : false;
      return c.json(out);
    }),
  );

  app.get("/api/tasks", (c) =>
    handle(c, async () => {
      const resolved = await resolveConfig(c, "github");
      const provider = resolved ? providersFor("github", resolved).tasks : undefined;
      if (!provider) return c.json({ source: null, tasks: [] });
      return c.json({ source: "github", tasks: await provider.listTasks() });
    }),
  );

  app.get("/api/calendar", (c) =>
    handle(c, async () => {
      const resolved = await resolveConfig(c, "github");
      const provider = resolved ? providersFor("github", resolved).calendar : undefined;
      if (!provider) return c.json({ source: null, events: [] });
      // Default window: 30 days back through 90 days ahead (covers releases + milestones).
      const now = Date.now();
      const from = c.req.query("from") ?? new Date(now - 30 * 864e5).toISOString();
      const to = c.req.query("to") ?? new Date(now + 90 * 864e5).toISOString();
      return c.json({ source: "github", events: await provider.listEvents({ from, to }) });
    }),
  );

  // ── per-user plugin settings (generic, schema-driven) ───────────────────────
  // The field schema is server-authoritative; secret values are encrypted at rest
  // and NEVER returned to the client (only whether each secret is set).
  app.get("/api/plugins/:id/settings", driveRoute(async (c, caller) => {
    const src = findSource(c.req.param("id")!);
    if (!src) return c.json({ error: "unknown source plugin" }, 404);
    const raw = await drive!.service.getPluginSettings(caller.sub, src.id);
    const stored = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    const values: Record<string, string> = {};
    const secretsSet: string[] = [];
    for (const f of src.configFields) {
      if (f.type === "secret") {
        if (stored[f.key]) secretsSet.push(f.key);
      } else if (stored[f.key] != null) {
        values[f.key] = stored[f.key]!;
      }
    }
    return c.json({ fields: src.configFields, values, secretsSet });
  }));

  app.put("/api/plugins/:id/settings", driveRoute(async (c, caller) => {
    const src = findSource(c.req.param("id")!);
    if (!src) return c.json({ error: "unknown source plugin" }, 404);
    const body = await c.req.json<{ values: Record<string, string | null> }>();
    const raw = await drive!.service.getPluginSettings(caller.sub, src.id);
    const stored = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    for (const f of src.configFields) {
      if (!(f.key in body.values)) continue; // omitted = unchanged
      const v = body.values[f.key];
      if (v == null || v === "") {
        // Empty secret = keep existing (so the user needn't re-enter it); empty
        // non-secret = clear the field.
        if (f.type !== "secret") delete stored[f.key];
        continue;
      }
      if (f.type === "secret") {
        if (!dataSources?.secret) return c.json({ error: "server has no SESSION_SECRET to encrypt secrets" }, 500);
        stored[f.key] = await encryptString(dataSources.secret, v);
      } else {
        stored[f.key] = v;
      }
    }
    await drive!.service.setPluginSettings(caller.sub, src.id, JSON.stringify(stored));
    return c.json({ ok: true });
  }));

  // ── per-user installed plugin set ───────────────────────────────────────────
  // Which plugins the caller has installed. With nothing persisted yet, fall back
  // to the auth-dependent defaults (Documentation is a default only when auth is
  // off — the anonymous/demo experience). Anonymous callers get 401 here and the
  // client uses its own anonymous default.
  app.get("/api/plugins/installed", driveRoute(async (c, caller) => {
    const stored = await drive!.service.getInstalledPlugins(caller.sub);
    const ids = stored ?? (authConfig ? DEFAULT_PLUGINS : ANON_DEFAULT_PLUGINS);
    return c.json({ ids });
  }));

  app.put("/api/plugins/installed", driveRoute(async (c, caller) => {
    const body = await c.req.json<{ ids?: unknown }>();
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
    await drive!.service.setInstalledPlugins(caller.sub, ids);
    return c.json({ ok: true });
  }));

  // WebDAV mount (read-only) — Basic auth via an app password, outside /api.
  if (drive) registerWebdav(app, drive);

  return app;
}
