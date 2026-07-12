import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import {
  createAiGateway,
  scopedCache,
  type AiGateway,
  type AiMessage,
  type AiModel,
  type AiProvider,
  type Calendar,
  type CalendarEvent,
  type Capability,
  type CacheStore,
  type ConnectorConfigField,
  type DocumentProcessor,
  type SearchIndex,
  type ServerDataSource,
  type StorageConnector,
  type Task,
} from "@canopy/core";
import {
  BlobHashMismatchError,
  BlobMissingError,
  NotFoundError,
  PermissionError,
  connectorSpaceId,
  crawlConnector,
  type BlobStore,
  type Caller,
  type EventInput,
  type FileService,
  type IndexJobs,
  type SchedulingStore,
  type TaskInput,
  type VersionPolicyKind,
} from "@canopy/store";
import type { DocWorker } from "@canopy/docworker";
import type { AuthConfig } from "./auth/config";
import { getSessionUser } from "./auth/routes";
import { registerWebdav } from "./webdav";
import { registerMcp } from "./mcp";
import type { ProcessingEntry } from "./processors";
import { AI_CONFIG_ID } from "./ai/user-config";
import { decryptPluginConfig, decryptString, encryptString } from "./crypto";

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

/** The slice of the per-space SSE Durable Object namespace the stream route uses
 *  (duck-typed so `apps/api` stays free of `@cloudflare/workers-types`). */
interface SpaceChannelNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}

/** Output token ceiling for /api/ai/generate, so a runaway generation can't rack up cost.
 * Generous because Plugin Studio emits a whole viewer module; capable models (Gemini
 * Flash) can do far more, while the cap still guards against an unbounded generation. */
const AI_MAX_TOKENS = 32768;
/** Max ESM source we'll persist for a generated plugin (a single sandboxed viewer module). */
const MAX_PLUGIN_SOURCE = 256 * 1024;
/** Capabilities a Studio-generated (sandboxed viewer) plugin may declare — nothing host-trusted. */
const SANDBOX_VIEWER_CAPS = new Set(["item:read", "item:write", "net:fetch"]);

/**
 * Structural check for a manifest submitted to `/api/plugins/custom`. The studio
 * builds two sandboxed kinds — a **file viewer** (`contributes.viewers`, opened by
 * matching files) or a standalone **app** (`contributes.detailView`, launched from
 * the sidebar) — so we accept either, but reject any capability the sandbox can't
 * safely back. Returns an error string, or null when the manifest is acceptable.
 * (The browser validates against the full JSON schema before submitting; this is
 * the server's defense-in-depth copy.)
 */
/** Reject task status/priority values outside their enums before they reach the store. */
function invalidTaskField(body: Partial<TaskInput>): string | null {
  if (body.status !== undefined && !["todo", "in_progress", "blocked", "done"].includes(body.status))
    return `invalid status: ${body.status}`;
  if (body.priority != null && !["low", "normal", "high"].includes(body.priority))
    return `invalid priority: ${body.priority}`;
  return null;
}

function validateCustomManifest(m: unknown): string | null {
  if (!m || typeof m !== "object") return "manifest must be an object";
  const man = m as { id?: unknown; name?: unknown; capabilities?: unknown; contributes?: unknown };
  if (typeof man.id !== "string" || !/^[a-z0-9][a-z0-9-]{1,48}$/.test(man.id))
    return "manifest.id must be kebab-case (2–49 chars)";
  if (typeof man.name !== "string" || !man.name.trim()) return "manifest.name is required";
  if (!Array.isArray(man.capabilities)) return "manifest.capabilities must be an array";
  for (const cap of man.capabilities as Capability[]) {
    if (!cap || typeof cap !== "object" || !SANDBOX_VIEWER_CAPS.has((cap as { kind?: string }).kind ?? ""))
      return `capability "${(cap as { kind?: string })?.kind}" is not allowed for a generated plugin`;
    if (cap.kind === "net:fetch" && (!Array.isArray(cap.hosts) || cap.hosts.length === 0))
      return "net:fetch requires a non-empty hosts list";
  }
  const contributes = man.contributes as { viewers?: unknown; detailView?: unknown } | undefined;
  const viewers = contributes?.viewers;
  const detailView = contributes?.detailView;
  const hasViewers = Array.isArray(viewers) && viewers.length > 0;
  const hasApp = !!detailView && typeof detailView === "object";
  if (!hasViewers && !hasApp)
    return "manifest must contribute at least one viewer or a detailView (app)";
  for (const v of (hasViewers ? (viewers as { match?: unknown }[]) : [])) {
    if (!Array.isArray(v.match) || v.match.length === 0) return "each viewer needs a non-empty match list";
  }
  if (hasApp) {
    const dv = detailView as { id?: unknown; title?: unknown };
    if (typeof dv.id !== "string" || !dv.id.trim()) return "detailView needs an id";
    if (typeof dv.title !== "string" || !dv.title.trim()) return "detailView needs a title";
  }
  return null;
}

/** Read up to `cap` bytes from a stream (so processors never load a huge file). */
async function readCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  void reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(total, cap));
  let off = 0;
  for (const ch of chunks) {
    if (off >= out.byteLength) break;
    const n = Math.min(ch.byteLength, out.byteLength - off);
    out.set(ch.subarray(0, n), off);
    off += n;
  }
  return out;
}

const PROCESSOR_MAX_BYTES = 8 * 1024 * 1024;
// Keep a file's processing log bounded — newest entries win.
const PROCESSING_LOG_MAX = 20;
// How long a lazy-on-view reconcile of a connected folder stays "fresh" — repeat
// views inside this window serve straight from the index without re-hitting the NAS.
const RECONCILE_DEBOUNCE_MS = 60_000;
// Files whose text we pull + index per opportunistic (lazy-on-view) drain slice.
const EXTRACT_DRAIN_LIMIT = 10;

/** The DB-backed drive: a file service plus the blob store for streaming downloads. */
export interface DriveDeps {
  service: FileService;
  blobs: BlobStore;
  /**
   * Document parser for the MCP read tools (ranged PDF text, outline, spreadsheet
   * tables). An adapter, so the heavy parsing can run in-process on pure Node or
   * be offloaded to a container backend — see {@link DocWorker}.
   */
  docWorker: DocWorker;
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
  /**
   * Builds a read-only {@link StorageConnector} from a source plugin's resolved
   * config, so a connected backend (e.g. a GitHub repo) can be browsed live as a
   * space. Returns null when the plugin has no connector or the config is
   * incomplete. The repo files are streamed straight from the connector — there are
   * no drive rows — so a connector-backed space is inherently read-only.
   */
  connectorFor?: (pluginId: string, config: Record<string, string>) => StorageConnector | null;
}

export interface AppDeps {
  auth?: Hono;
  authConfig?: AuthConfig | null;
  /** Read-only mounts (documentation, demo) served from a StorageConnector — NOT the drive. */
  readonlyMounts?: Record<string, StorageConnector>;
  /** The user's drive, backed by @canopy/store (D1/libsql + R2/fs). */
  drive?: DriveDeps;
  /**
   * The owned scheduling store (#34): calendars (= virtual folders), events, and
   * tasks the user creates, reusing the drive's space/folder/permission model.
   * Reads aggregate into `/api/calendar` and `/api/tasks` alongside external
   * data-source providers; writes go through the dedicated REST routes here.
   */
  scheduling?: SchedulingStore;
  /** Connected data-source plugins feeding tasks/calendar. */
  dataSources?: DataSourceDeps;
  /** Server-side document processors run when a file is added (e.g. AI labeling). */
  processors?: DocumentProcessor[];
  /**
   * The deployment's **base** AI gateway: providers configured at the host level —
   * Cloudflare Workers AI (the env.AI binding) or env-keyed providers. Shared by
   * everyone. A caller's own UI-configured providers (see `aiUserConfig`) are
   * layered on top per request.
   */
  ai?: AiGateway;
  /**
   * Lets users add their own AI providers (a Gemini key, an OpenAI-compatible
   * endpoint) in Settings → AI models. `fields` is the config schema (persisted via
   * the generic per-user settings store, secrets encrypted); `build` turns a
   * caller's decrypted config into providers layered over the base gateway.
   */
  aiUserConfig?: {
    fields: ConnectorConfigField[];
    build: (config: Record<string, string>) => AiProvider[];
  };
  /**
   * The deployment's search index — the SQL FTS adapter on both targets (libsql
   * on Node, D1 on Cloudflare), chosen here the same way the cache backend is.
   * A reserved slot: the feed (#20) and the scoped `index:query` grant (#21) wire
   * into it; nothing consumes it yet.
   */
  search?: SearchIndex;
  /** Keep background work (e.g. labeling) alive after the response — `ctx.waitUntil` on a Worker. */
  waitUntil?: (p: Promise<unknown>) => void;
  /**
   * Background connector-indexing runner (the {@link IndexJobs} port). On Cloudflare a
   * Workflow + Queue; on Node an in-process loop. When present, "Sync now" and on-connect
   * enqueue through it instead of the inline crawl. Absent → the inline fallback runs.
   */
  indexJobs?: IndexJobs;
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
  const { authConfig = null, readonlyMounts = {}, drive, scheduling, dataSources, processors = [], ai } = deps;
  // Run background work via the host's keep-alive (Worker ctx.waitUntil) if given;
  // on Node a bare promise survives because the process stays up.
  const runBackground = (p: Promise<unknown>) => (deps.waitUntil ? deps.waitUntil(p) : void p);

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
  // A "connected" space is read-only and backed by a source plugin's connector
  // (e.g. a GitHub repo), addressed as "connector:<pluginId>". It has no rows in the
  // drive — its listing and content come live from the connector — so writes are
  // refused: `resolveSpace` (used by every write route) never returns one.
  const CONNECTOR_SPACE = "connector:";
  const isConnectorSpace = (id?: string | null): id is string => !!id && id.startsWith(CONNECTOR_SPACE);

  async function resolveSpace(c: Context, sub: string): Promise<string> {
    const space = c.req.query("space");
    if (isConnectorSpace(space)) throw new PermissionError("connected spaces are read-only");
    return space ?? (await drive!.service.personalSpace(sub));
  }

  // The live connector + display name for a connected space, or null when the caller
  // has nothing configured for that plugin (so it isn't connected). Anonymous callers
  // fall back to the demo default, mirroring the read-only mounts.
  async function connectorSpace(c: Context, spaceId: string): Promise<{ connector: StorageConnector; name: string } | null> {
    const pluginId = spaceId.slice(CONNECTOR_SPACE.length);
    const resolved = await resolveConfig(c, pluginId);
    const connector = resolved && dataSources?.connectorFor ? dataSources.connectorFor(pluginId, resolved.config) : null;
    return connector ? { connector, name: resolved!.config.repo ?? pluginId } : null;
  }

  // The live connector for a *writable* connected space (a NAS), or null when the
  // space isn't a configured, writable connector space. A writable source plugin
  // (`writable: true`) is served read-write — its connected space accepts folder
  // creates and uploads, routed through the connector. Gates every connector write.
  async function writableConnectorSpace(
    c: Context,
    spaceId?: string | null,
  ): Promise<{ connector: StorageConnector; name: string; pluginId: string } | null> {
    if (!isConnectorSpace(spaceId)) return null;
    const pluginId = spaceId.slice(CONNECTOR_SPACE.length);
    if (!sourcePlugins.find((p) => p.id === pluginId)?.writable) return null;
    const cs = await connectorSpace(c, spaceId);
    return cs ? { ...cs, pluginId } : null;
  }

  // After a connector write, converge the affected folder so the new file/folder
  // gets a real index row (and a stable id) like any space. Returns the space id.
  async function reconcileConnectorWrite(
    sub: string,
    cw: { connector: StorageConnector; name: string; pluginId: string },
    dir: string,
  ): Promise<string> {
    const spaceId = await drive!.service.ensureConnectorSpace(sub, cw.pluginId, cw.name);
    await drive!.service.reconcileConnectorFolder(sub, spaceId, cw.pluginId, cw.connector, dir);
    return spaceId;
  }

  // The parent folder of a space-relative path ("docs/a.txt" → "docs", "a.txt" → "").
  const parentDir = (p: string) => p.split("/").slice(0, -1).join("/");

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
    const space = c.req.query("space");
    const connector = mount
      ? readonlyMounts[mount]
      : isConnectorSpace(space)
        ? (await connectorSpace(c, space))?.connector
        : undefined;
    if (!connector) return c.json({ error: "unknown mount" }, 404);
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path required" }, 400);
    const entry = await connector.stat(path);
    if (!entry || entry.kind === "folder") return c.json({ error: "not found" }, 404);
    c.header("Content-Type", mimeFor(entry.name));
    const disposition = c.req.query("download") != null ? "attachment" : "inline";
    c.header("Content-Disposition", `${disposition}; filename="${encodeURIComponent(entry.name)}"`);
    return c.body(await connector.read(path));
  });

  // Read a plugin's saved config for a user, decrypting secret fields.
  async function decryptedSettings(
    sub: string,
    plugin: { id: string; configFields: ConnectorConfigField[] },
  ): Promise<Record<string, string>> {
    if (!drive) return {};
    const raw = await drive.service.getPluginSettings(sub, plugin.id);
    return decryptPluginConfig(dataSources?.secret, plugin.configFields, raw);
  }

  // Best-effort: run configured document processors over a freshly-added file and
  // merge what they produce (type labels, a description) into its metadata, and
  // append a per-run entry to the file's processing log so the user can see whether
  // — and how — it was processed. Runs in the background (does not block the upload
  // response). On a Worker, pass this to ctx.waitUntil; a future migration moves it
  // onto the task runner (the `enrichItem` hook) — see the plugin docs.
  async function labelFileInBackground(sub: string, file: Awaited<ReturnType<FileService["createFile"]>>): Promise<void> {
    if (processors.length === 0 || !drive) return;
    const blobKey = file.version?.blobKey;
    if (!blobKey) return;
    try {
      const stream = await drive.blobs.get(blobKey);
      if (!stream) return;
      const bytes = await readCapped(stream, PROCESSOR_MAX_BYTES);
      const mime = file.version?.mime ?? mimeFor(file.name);
      // The uploader's effective gateway (their UI-configured providers + the base).
      const gateway = await gatewayFor(sub);
      const labels = new Set<string>();
      let description: string | undefined;
      const entries: ProcessingEntry[] = [];

      for (const p of processors) {
        const config = await decryptedSettings(sub, p);
        const isEligible = p.eligible
          ? p.eligible(config, { ai: gateway })
          : p.configFields.filter((f) => f.required).every((f) => config[f.key]);
        if (!isEligible) {
          // Nothing to run (no provider / not configured) — not a processing event, so don't log it.
          console.log(`[processor:${p.id}] skip "${file.name}" — not configured`);
          continue;
        }
        console.log(`[processor:${p.id}] processing "${file.name}" (${mime}, ${bytes.byteLength} bytes)`);
        const at = new Date().toISOString();
        try {
          const out = await p.process({ name: file.name, mime, bytes }, config, { ai: gateway });
          for (const l of out.labels) labels.add(l);
          // First non-empty description wins; never clobber one the user already set.
          if (out.description && description === undefined) description = out.description;
          const status = out.error ? "error" : "ok";
          entries.push({
            at,
            plugin: p.id,
            status,
            model: out.model,
            labels: out.labels.length ? out.labels : undefined,
            described: !!out.description,
            note: out.error,
          });
          console.log(
            `[processor:${p.id}] "${file.name}" → ${status}` +
              (out.labels.length ? ` labels=[${out.labels.join(", ")}]` : "") +
              (out.description ? " +description" : "") +
              (out.error ? ` (${out.error})` : ""),
          );
        } catch (err) {
          const note = (err as Error).message;
          entries.push({ at, plugin: p.id, status: "error", model: undefined, note });
          console.warn(`[processor:${p.id}] failed for "${file.name}": ${note}`);
        }
      }

      if (entries.length === 0) return; // nothing configured ran
      const patch: Record<string, unknown> = {};
      if (labels.size > 0) {
        const existing = Array.isArray(file.metadata?.labels) ? (file.metadata.labels as string[]) : [];
        patch.labels = [...new Set([...existing, ...labels])];
      }
      const existingDescription = typeof file.metadata?.description === "string" ? file.metadata.description : "";
      if (description && !existingDescription.trim()) patch.description = description;
      const priorLog = Array.isArray(file.metadata?.processing) ? (file.metadata.processing as ProcessingEntry[]) : [];
      patch.processing = [...priorLog, ...entries].slice(-PROCESSING_LOG_MAX);

      await drive.service.patchMetadata({ sub }, file.id, patch);
      console.log(`[processor] saved for "${file.name}": ${entries.length} run(s), labels=[${[...labels].join(", ")}]`);
    } catch (err) {
      // Best-effort: never surface to the upload, but do log so failures are visible.
      console.warn(`[processor] failed for "${file.name}": ${(err as Error).message}`);
    }
  }

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
      // A connected space (a Synology NAS, a GitHub repo): a persisted index over
      // the connector. We converge the viewed folder against the backend, then list
      // it from the drive — so its files have real ids and flow through search / MCP
      // / download like any space. Debounced so rapid repeat views skip the NAS.
      const connectorTarget = c.req.query("space");
      if (isConnectorSpace(connectorTarget)) {
        if (!drive) return c.json({ error: "no drive configured" }, 404);
        const caller = await callerOf(c);
        if (!caller) return c.json({ error: "unauthorized" }, 401);
        const cs = await connectorSpace(c, connectorTarget);
        if (!cs) return c.json({ error: "not connected" }, 404);
        const dir = c.req.query("path") ?? "";
        const pluginId = connectorTarget.slice(CONNECTOR_SPACE.length);
        const spaceId = await drive.service.ensureConnectorSpace(caller.sub, pluginId, cs.name);
        // An explicit refresh (`?fresh`) bypasses the debounce so a folder the user is
        // already viewing still re-converges against the backend (e.g. a new GitHub
        // subfolder added on the current branch shows on the next refresh, not 60s later).
        const force = c.req.query("fresh") != null;
        const debounceKey = `reconcile:${spaceId}:${dir}`;
        const cached = !force && dataSources?.cache ? await dataSources.cache.get<string>(debounceKey) : null;
        if (!cached) {
          await drive.service.reconcileConnectorFolder(caller.sub, spaceId, pluginId, cs.connector, dir);
          if (dataSources?.cache) await dataSources.cache.set(debounceKey, "1", RECONCILE_DEBOUNCE_MS);
          // Pull + index a slice of any newly-seen files' text, off the response path.
          runBackground(drive.service.drainExternalExtractQueue(EXTRACT_DRAIN_LIMIT).catch(() => {}));
        }
        const result = await drive.service.list(caller.sub, spaceId, dir);
        return c.json({ ...result, spaceName: cs.name });
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

  // Full-text search across the files the caller can read. The drive service
  // resolves the caller's readable spaces into the ACL scope (the query never
  // carries space ids), then queries the index. Empty `q` → empty result.
  app.get("/api/search", driveRoute(async (c, caller) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json({ items: [] });
    const limit = Number(c.req.query("limit")) || undefined;
    const cursor = c.req.query("cursor") || undefined;
    return c.json(await drive!.service.search(caller.sub, { text: q, limit, cursor }));
  }));

  // Offline-mirror delta: every file-metadata change in the caller's spaces since
  // their last cursor. `?since=` is a URL-encoded JSON `{spaceId: seq}` map (absent →
  // bootstrap every space). The ACL scope is resolved server-side (the cursor only
  // carries seqs, never widens it), so this can't reach a space the caller can't read.
  // `limit` caps the page; `hasMore` tells the client to pull again. See @canopy/mirror.
  app.get("/api/changes", driveRoute(async (c, caller) => {
    let since: Record<string, number> = {};
    const raw = c.req.query("since");
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object") {
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === "number" && Number.isFinite(v)) since[k] = v;
          }
        }
      } catch {
        // Malformed cursor → treat as bootstrap (return everything) rather than 400;
        // a corrupt client cursor should self-heal, not wedge the drive offline.
        since = {};
      }
    }
    const limit = Number(c.req.query("limit")) || undefined;
    return c.json(await drive!.service.changesSince(caller.sub, since, limit));
  }));

  // Live nudge: an SSE stream that emits a `bump` whenever the given space advances,
  // so a connected client pulls the delta promptly. One stream per space (`?space=`,
  // default = the caller's personal space). The stream carries no file data — only
  // "go pull" — so access here just needs to gate WHICH space you can listen to.
  // Backed by the per-space `SpaceChannel` Durable Object; without that binding (Node)
  // we 204 and the client falls back to polling. See lib/sync.ts on the client.
  app.get("/api/changes/stream", driveRoute(async (c, caller) => {
    const channel = (c.env as { SPACE_CHANNEL?: SpaceChannelNamespace } | undefined)?.SPACE_CHANNEL;
    if (!channel) return c.body(null, 204); // no live channel (e.g. Node) — poll instead
    const space = c.req.query("space") || (await drive!.service.personalSpace(caller.sub));
    // Gate the subscription to a space the caller can actually read.
    const spaces = await drive!.service.spaces(caller.sub);
    if (!spaces.some((s) => s.id === space)) return c.json({ error: "forbidden" }, 403);
    const stub = channel.get(channel.idFromName(space));
    return stub.fetch(`https://space-channel/stream?space=${encodeURIComponent(space)}`);
  }));

  // Force a (re-)index of a connected space (the "Sync now" / context-menu action):
  // crawl the whole tree + drain extraction, ignoring the lazy-view debounce. Routed
  // through the IndexJobs port when wired (a durable CF Workflow / the Node loop); else
  // the inline crawl fallback. Either way it's backgrounded so the request returns at once.
  app.post("/api/connector/:pluginId/sync", driveRoute(async (c, caller) => {
    const pluginId = c.req.param("pluginId")!;
    const cs = await connectorSpace(c, `${CONNECTOR_SPACE}${pluginId}`);
    if (!cs) return c.json({ error: "not connected" }, 404);
    const spaceId = await drive!.service.ensureConnectorSpace(caller.sub, pluginId, cs.name);
    const target = { ownerSub: caller.sub, spaceId, pluginId };
    if (deps.indexJobs) {
      runBackground(deps.indexJobs.startConnectorIndex(target));
    } else {
      runBackground(
        (async () => {
          try {
            await crawlConnector(drive!.service, target, cs.connector);
            await drive!.service.drainExternalExtractQueue(EXTRACT_DRAIN_LIMIT);
          } catch (err) {
            console.warn(`[sync] force-sync ${pluginId} failed: ${(err as Error).message}`);
          }
        })(),
      );
    }
    return c.json({ started: true });
  }));

  // Indexing state of a connected space (the sidebar polls this to show an "Indexing…"
  // hint). DB-only — no connector round-trip — so it's cheap to hit on a short interval.
  app.get("/api/connector/:pluginId/status", driveRoute(async (c, caller) =>
    c.json(await drive!.service.connectorIndexStatus(caller.sub, c.req.param("pluginId")!)),
  ));

  // Live indexing log: an SSE stream of the connector crawl's progress lines, for the
  // space-settings dialog. Keyed by the caller's OWN connector space id (the same id the
  // index Workflow posts `/log` lines to), so no extra ACL beyond auth — you can only
  // ever reach your own connector's channel. Lines are transient (never stored): the DO
  // fans out `index` events live; without the binding (Node) we 204 and the dialog shows
  // status only. Mirrors `/api/changes/stream`.
  app.get("/api/connector/:pluginId/logs/stream", driveRoute(async (c, caller) => {
    const channel = (c.env as { SPACE_CHANNEL?: SpaceChannelNamespace } | undefined)?.SPACE_CHANNEL;
    if (!channel) return c.body(null, 204); // no live channel (e.g. Node) — poll status instead
    const spaceId = connectorSpaceId(caller.sub, c.req.param("pluginId")!);
    const stub = channel.get(channel.idFromName(spaceId));
    return stub.fetch(`https://space-channel/stream?space=${encodeURIComponent(spaceId)}`);
  }));

  // Read/write the connected space's version-retention policy (Keep all / Smart / Keep N
  // days). The connector space is owned by the caller, so they can configure their own
  // NAS/repo even though it's read-only to writes. `ensureConnectorSpace` makes the read
  // valid before the user has ever browsed the space.
  app.get("/api/connector/:pluginId/settings", driveRoute(async (c, caller) => {
    const pluginId = c.req.param("pluginId")!;
    const cs = await connectorSpace(c, `${CONNECTOR_SPACE}${pluginId}`);
    if (!cs) return c.json({ error: "not connected" }, 404);
    const spaceId = await drive!.service.ensureConnectorSpace(caller.sub, pluginId, cs.name);
    return c.json(await drive!.service.spaceVersionPolicy(caller, spaceId));
  }));

  app.put("/api/connector/:pluginId/settings", driveRoute(async (c, caller) => {
    const pluginId = c.req.param("pluginId")!;
    const cs = await connectorSpace(c, `${CONNECTOR_SPACE}${pluginId}`);
    if (!cs) return c.json({ error: "not connected" }, 404);
    const body = await c.req.json<{ versionPolicy?: string; versionDays?: number | null }>();
    const policy = body.versionPolicy;
    if (policy !== "all" && policy !== "smart" && policy !== "days") return c.json({ error: "invalid policy" }, 400);
    const days = policy === "days" ? Math.floor(Number(body.versionDays)) : null;
    if (policy === "days" && (!Number.isFinite(days) || (days as number) < 1)) {
      return c.json({ error: "versionDays must be a positive integer" }, 400);
    }
    const spaceId = await drive!.service.ensureConnectorSpace(caller.sub, pluginId, cs.name);
    return c.json(await drive!.service.setSpaceVersionPolicy(caller, spaceId, policy as VersionPolicyKind, days));
  }));

  // ── connected-space branches (a GitHub repo's refs) ─────────────────────────
  // A connector may expose branch management (StorageConnector.branches). The repo
  // is rooted at one branch; switching is a config change we persist + re-index,
  // while create/delete are live writes against the backend (need a write token).

  // List the connected space's branches. `supported:false` when this connector has
  // no branch concept (a NAS) — the UI then shows no picker.
  app.get("/api/connector/:pluginId/branches", driveRoute(async (c, caller) => {
    const pluginId = c.req.param("pluginId")!;
    const cs = await connectorSpace(c, `${CONNECTOR_SPACE}${pluginId}`);
    if (!cs) return c.json({ error: "not connected" }, 404);
    if (!cs.connector.branches) return c.json({ supported: false, current: null, branches: [] });
    const resolved = await resolveConfig(c, pluginId);
    try {
      const branches = await cs.connector.branches.list();
      return c.json({
        supported: true,
        current: cs.connector.branch ?? null,
        // Only the owner of the config can persist a switch; the demo default can't.
        canSwitch: !!resolved?.own,
        branches,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  }));

  // Create a branch on the backend (from another ref, default = the current branch).
  app.post("/api/connector/:pluginId/branches", driveRoute(async (c, caller) => {
    const pluginId = c.req.param("pluginId")!;
    const cs = await connectorSpace(c, `${CONNECTOR_SPACE}${pluginId}`);
    if (!cs?.connector.branches) return c.json({ error: "branches not supported" }, 400);
    const body = await c.req.json<{ name?: string; from?: string }>();
    const name = body.name?.trim();
    if (!name) return c.json({ error: "branch name required" }, 400);
    try {
      await cs.connector.branches.create(name, body.from?.trim() || undefined);
      return c.json({ ok: true }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  }));

  // Delete a branch on the backend. The name is a query param (`?name=`) so a branch
  // with a "/" — e.g. "feature/x" — doesn't fight the path router.
  app.delete("/api/connector/:pluginId/branches", driveRoute(async (c, caller) => {
    const pluginId = c.req.param("pluginId")!;
    const name = (c.req.query("name") ?? "").trim();
    if (!name) return c.json({ error: "branch name required" }, 400);
    const cs = await connectorSpace(c, `${CONNECTOR_SPACE}${pluginId}`);
    if (!cs?.connector.branches) return c.json({ error: "branches not supported" }, 400);
    if (name === cs.connector.branch) return c.json({ error: "can't delete the branch you're viewing" }, 400);
    try {
      await cs.connector.branches.remove(name);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  }));

  // Switch the branch the connected space is rooted at: persist `branch` into the
  // caller's plugin settings, then re-index so the space reflects the new ref. Needs
  // the caller's own config (the demo default has nothing to persist into).
  app.put("/api/connector/:pluginId/branch", driveRoute(async (c, caller) => {
    const pluginId = c.req.param("pluginId")!;
    const src = findSource(pluginId);
    if (!src) return c.json({ error: "unknown plugin" }, 404);
    const body = await c.req.json<{ branch?: string }>();
    const branch = body.branch?.trim();
    if (!branch) return c.json({ error: "branch required" }, 400);
    const resolved = await resolveConfig(c, pluginId);
    if (!resolved?.own) {
      return c.json({ error: "Connect your own repository in the plugin settings to switch branches." }, 400);
    }
    const raw = await drive!.service.getPluginSettings(caller.sub, pluginId);
    const stored = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    stored.branch = branch;
    await drive!.service.setPluginSettings(caller.sub, pluginId, JSON.stringify(stored));
    // Re-index against the new branch so the connected space's files/search converge.
    if (deps.indexJobs && dataSources?.connectorFor) {
      const spaceId = await drive!.service.ensureConnectorSpace(caller.sub, pluginId, resolved.config.repo ?? pluginId);
      runBackground(deps.indexJobs.startConnectorIndex({ ownerSub: caller.sub, spaceId, pluginId }));
    }
    return c.json({ ok: true, branch });
  }));

  // Spaces the caller can see (for the space switcher). Real drive spaces, plus a
  // read-only "connected" space for each source plugin the caller has a connector
  // configured for (e.g. their GitHub repo) — derived from the plugin's settings,
  // not stored, so reconfiguring the repo moves the space with it.
  app.get("/api/spaces", driveRoute(async (c, caller) => {
    const spaces: unknown[] = await drive!.service.spaces(caller.sub);
    if (dataSources?.connectorFor) {
      for (const p of sourcePlugins) {
        const resolved = await resolveConfig(c, p.id);
        const connector = resolved ? dataSources.connectorFor(p.id, resolved.config) : null;
        if (!connector) continue;
        const name = resolved!.config.repo ?? p.id;
        // Persist the connected space so search reaches its files even before the
        // user browses it; its public id stays `connector:<plugin>` for the UI.
        await drive!.service.ensureConnectorSpace(caller.sub, p.id, name);
        spaces.push({
          id: `${CONNECTOR_SPACE}${p.id}`,
          name,
          kind: "connected",
          role: p.writable ? "editor" : "viewer",
          mounted: false,
          // A writable source (a NAS) is served read-write; an indexed repo stays read-only.
          readonly: !p.writable,
        });
      }
    }
    return c.json(spaces);
  }));

  // Create a shared (group) space — e.g. a family. `icon`/`color` are optional
  // presentation hints (icon name + HSL-triplet accent) for the sidebar.
  app.post("/api/spaces", driveRoute(async (c, caller) => {
    const { name, icon, color } = await c.req.json<{ name: string; icon?: string | null; color?: string | null }>();
    const trimmed = name?.trim();
    if (!trimmed) return c.json({ error: "name required" }, 400);
    return c.json(
      await drive!.service.createSpace(caller, { name: trimmed, icon: icon ?? null, color: color ?? null }),
      201,
    );
  }));

  // Rename a space. Owner only.
  app.patch("/api/spaces/:id", driveRoute(async (c, caller) => {
    const { name } = await c.req.json<{ name?: string }>();
    const trimmed = name?.trim();
    if (!trimmed) return c.json({ error: "name required" }, 400);
    return c.json(await drive!.service.renameSpace(caller, c.req.param("id")!, trimmed));
  }));

  // Permanently delete a group space and everything in it. Owner only.
  app.delete("/api/spaces/:id", driveRoute(async (c, caller) => {
    await drive!.service.deleteSpace(caller, c.req.param("id")!);
    return c.json({ ok: true });
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

  app.post("/api/spaces/:id/members/remove", driveRoute(async (c, caller) => {
    const { sub } = await c.req.json<{ sub: string }>();
    if (!sub) return c.json({ error: "sub required" }, 400);
    await drive!.service.removeSpaceMember(caller, c.req.param("id")!, sub);
    return c.json({ ok: true });
  }));

  // Plugins applied to a space (the per-place layer). Any member may see what runs;
  // only an owner ("admin" of the place) may apply or remove a plugin — applying
  // turns it on for everyone in the space.
  app.get("/api/spaces/:id/plugins", driveRoute(async (c, caller) =>
    c.json({ ids: await drive!.service.spacePlugins(caller, c.req.param("id")!) }),
  ));

  app.post("/api/spaces/:id/plugins", driveRoute(async (c, caller) => {
    const { pluginId } = await c.req.json<{ pluginId?: string }>();
    if (!pluginId) return c.json({ error: "pluginId required" }, 400);
    await drive!.service.applySpacePlugin(caller, c.req.param("id")!, pluginId);
    return c.json({ ok: true }, 201);
  }));

  app.delete("/api/spaces/:id/plugins/:pluginId", driveRoute(async (c, caller) => {
    await drive!.service.removeSpacePlugin(caller, c.req.param("id")!, c.req.param("pluginId")!);
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
    const file = await drive!.service.createFile(space, caller.sub, body);
    runBackground(labelFileInBackground(caller.sub, file)); // AI labeling, off the response path
    return c.json(file, 201);
  }));

  // Create an (empty) folder in a space.
  app.post("/api/folders", driveRoute(async (c, caller) => {
    const { path } = await c.req.json<{ path: string }>();
    if (!path) return c.json({ error: "path required" }, 400);
    // A writable connected space (a NAS): create the folder on the connector, then
    // reconcile so it appears in the index. (resolveSpace would refuse it below.)
    const cw = await writableConnectorSpace(c, c.req.query("space"));
    if (cw) {
      if (!cw.connector.mkdir) throw new PermissionError("connector cannot create folders");
      await cw.connector.mkdir(path);
      await reconcileConnectorWrite(caller.sub, cw, parentDir(path));
      return c.json({ ok: true }, 201);
    }
    const space = await resolveSpace(c, caller.sub);
    return c.json(await drive!.service.createFolder(space, caller.sub, path), 201);
  }));

  // Upload bytes straight into a writable connected space (a NAS): write through the
  // connector, reconcile the folder, and return the resulting indexed file (so the UI
  // gets a real id to open). The managed blob-store flow (/api/uploads/* → /api/files)
  // doesn't apply here — the NAS is the source of truth, not the blob store.
  // `?space=connector:<plugin>` + `?path=<space-relative file path>`; body = raw bytes.
  app.put("/api/connector-files", driveRoute(async (c, caller) => {
    const cw = await writableConnectorSpace(c, c.req.query("space"));
    if (!cw) throw new PermissionError("space is read-only");
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path required" }, 400);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    await cw.connector.write(path, bytes);
    const spaceId = await reconcileConnectorWrite(caller.sub, cw, parentDir(path));
    const name = path.split("/").pop()!;
    const listing = await drive!.service.list(caller.sub, spaceId, parentDir(path));
    const file = listing.files.find((f: { name: string }) => f.name === name);
    return c.json(file ?? { ok: true }, 201);
  }));

  // Lightweight stats for the dashboard (file count + bytes used in a space).
  app.get("/api/overview", driveRoute(async (c, caller) => {
    if (isConnectorSpace(c.req.query("space"))) return c.json({ files: 0, bytes: 0 });
    const space = await resolveSpace(c, caller.sub);
    return c.json(await drive!.service.overview(caller.sub, space));
  }));

  app.get("/api/files/:id", driveRoute(async (c, caller) =>
    c.json(await drive!.service.getFileForDisplay(caller, c.req.param("id")!)),
  ));

  // Download bytes. `?embed=true` would project metadata into the file where the
  // format supports it; today it passes through (see README).
  app.get("/api/files/:id/content", driveRoute(async (c, caller) => {
    const file = await drive!.service.getFile(caller, c.req.param("id")!);
    if (!file.version) return c.json({ error: "no content" }, 404);
    // A content identity that changes iff the bytes change: the blob hash (managed), the
    // connector etag (external), else the version id. Lets the client serve a cached copy
    // instantly and revalidate in the background with If-None-Match → 304 — and a 304 is
    // metadata-only (no blob/NAS read), so the freshness check stays cheap even for a
    // connector file whose backend is slow.
    const tag = `"${file.version.blobKey ?? file.version.etag ?? file.version.id}"`;
    c.header("ETag", tag);
    c.header("Cache-Control", "no-cache"); // always revalidate; never serve stale without checking
    // Strip a weak-validator prefix some clients/proxies add (`W/"…"`) so the 304 still fires.
    if (c.req.header("if-none-match")?.replace(/^W\//, "") === tag) return c.body(null, 304);
    // Managed blobs stream from the blob store; external (indexed) sources stream
    // through their connector — both behind one opener.
    const stream = await drive!.service.openContentStream(file);
    if (!stream) return c.json({ error: "content unavailable" }, 404);
    c.header("Content-Type", file.version.mime ?? mimeFor(file.name));
    // ?download forces a save dialog; the default inline lets previewable types render in-page.
    const disposition = c.req.query("download") != null ? "attachment" : "inline";
    c.header("Content-Disposition", `${disposition}; filename="${encodeURIComponent(file.name)}"`);
    return c.body(stream);
  }));

  // Metadata edit — never creates a new version.
  app.patch("/api/files/:id/metadata", driveRoute(async (c, caller) => {
    const patch = await c.req.json<Record<string, unknown>>();
    return c.json(await drive!.service.patchMetadata(caller, c.req.param("id")!, patch));
  }));

  // Re-run the default processing pipeline for a single file: re-extract its text +
  // re-feed the search index now (editor-gated), then re-run configured AI document
  // processors over the current bytes off the response path — the same enrichment a
  // fresh upload gets. Useful when a processor was added/reconfigured after upload, or
  // a connector-backed file changed out-of-band. Returns 202: the AI pass is async.
  app.post("/api/files/:id/reprocess", driveRoute(async (c, caller) => {
    const id = c.req.param("id")!;
    await drive!.service.reprocess(caller, id);
    const file = await drive!.service.getFile(caller, id);
    runBackground(labelFileInBackground(caller.sub, file));
    return c.json({ ok: true }, 202);
  }));

  // Stage a blob for a *specific file's* next version, keyed to the file's own
  // space and gated by editor on the file. Unlike /api/uploads/* (which keys by
  // ?space=), this can't land the blob in the wrong space, so the version POST
  // below always finds it — including for files shared from another space.
  app.post("/api/files/:id/uploads/prepare", driveRoute(async (c, caller) => {
    const { hash } = await c.req.json<{ hash: string; size?: number }>();
    if (!hash) return c.json({ error: "hash required" }, 400);
    const id = c.req.param("id")!;
    const res = await drive!.service.prepareFileUpload(caller, id, hash);
    return c.json(res.exists ? { exists: true } : { exists: false, upload: { method: "PUT", url: `/api/files/${id}/uploads/${hash}` } });
  }));

  // Stream bytes for a file-scoped blob; the token is the claimed hash, re-verified.
  app.put("/api/files/:id/uploads/:hash", driveRoute(async (c, caller) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const res = await drive!.service.commitFileUpload(caller, c.req.param("id")!, c.req.param("hash")!, bytes);
    return c.json({ hash: res.hash, size: res.size }, 201);
  }));

  // New content version — never alters metadata. Dedup applies to its blob.
  // Rapid successive saves by the same author coalesce into the current version.
  app.post("/api/files/:id/versions", driveRoute(async (c, caller) => {
    const body = await c.req.json<{ hash: string; mime?: string; coalesce?: boolean }>();
    if (!body.hash) return c.json({ error: "hash required" }, 400);
    return c.json(await drive!.service.addVersion(caller, c.req.param("id")!, body));
  }));

  // Version history (newest first).
  app.get("/api/files/:id/versions", driveRoute(async (c, caller) =>
    c.json(await drive!.service.listVersions(caller, c.req.param("id")!)),
  ));

  // Download a specific past version's bytes (history → download an old one).
  app.get("/api/files/:id/versions/:versionId/content", driveRoute(async (c, caller) => {
    const file = await drive!.service.getFile(caller, c.req.param("id")!);
    const { key, version } = await drive!.service.getVersionContentKey(
      caller,
      c.req.param("id")!,
      c.req.param("versionId")!,
    );
    const stream = await drive!.blobs.get(key);
    if (!stream) return c.json({ error: "blob missing" }, 404);
    c.header("Content-Type", version.mime ?? mimeFor(file.name));
    c.header("Content-Disposition", `attachment; filename="${encodeURIComponent(file.name)}"`);
    return c.body(stream);
  }));

  // Restore an older version: appends its content as the new current version.
  app.post("/api/files/:id/versions/:versionId/restore", driveRoute(async (c, caller) =>
    c.json(await drive!.service.restoreVersion(caller, c.req.param("id")!, c.req.param("versionId")!)),
  ));

  // Pin/unpin a version so retention/pruning never removes it.
  app.post("/api/files/:id/versions/:versionId/keep", driveRoute(async (c, caller) => {
    const { keep } = await c.req.json<{ keep: boolean }>();
    await drive!.service.keepVersion(caller, c.req.param("id")!, c.req.param("versionId")!, !!keep);
    return c.json({ ok: true });
  }));

  // Recent processor runs across the caller's spaces (a plugin's activity view).
  // `?plugin=` filters to one processor (e.g. document-ai); `?limit=` caps the count.
  app.get("/api/processing", driveRoute(async (c, caller) => {
    const plugin = c.req.query("plugin") || undefined;
    const limit = Number(c.req.query("limit")) || undefined;
    return c.json(await drive!.service.recentProcessing(caller.sub, { plugin, limit }));
  }));

  // ── comments (a discussion thread on a file) ──────────────────────────────────
  // Tags + descriptions aren't here — they're metadata edits via the PATCH route above.

  // A file's comments, oldest first.
  app.get("/api/files/:id/comments", driveRoute(async (c, caller) =>
    c.json(await drive!.service.listComments(caller, c.req.param("id")!)),
  ));

  // Post a comment. Anyone who can see the file (viewer+) can comment.
  app.post("/api/files/:id/comments", driveRoute(async (c, caller) => {
    const { body } = await c.req.json<{ body?: string }>();
    if (!body || !body.trim()) return c.json({ error: "body required" }, 400);
    return c.json(await drive!.service.addComment(caller, c.req.param("id")!, body), 201);
  }));

  // Soft-delete a comment (author or file owner only).
  app.delete("/api/files/:id/comments/:commentId", driveRoute(async (c, caller) => {
    await drive!.service.deleteComment(caller, c.req.param("id")!, c.req.param("commentId")!);
    return c.json({ ok: true });
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

  // People the caller is connected to (space co-members + file-share peers),
  // filtered by `?q=`. Powers the share-with picker so they pick a known
  // contact instead of retyping an address.
  app.get("/api/people", driveRoute(async (c, caller) =>
    c.json(await drive!.service.connectedPeople(caller, c.req.query("q") ?? undefined)),
  ));

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

  app.post("/api/files/:id/grants/unshare", driveRoute(async (c, caller) => {
    const body = await c.req.json<{ subjectType: "user" | "space" | "email"; subjectId: string; role: "owner" | "editor" | "viewer" }>();
    await drive!.service.unshareGrant(caller, c.req.param("id")!, body);
    return c.json({ ok: true });
  }));

  // ── per-folder sharing (grants on a folder + its subtree) ────────────────────
  // Keyed by space id + ?path= (the folder's virtual path). Mirrors file grants,
  // including share-by-email resolution.

  app.get("/api/spaces/:id/folder-grants", driveRoute(async (c, caller) =>
    c.json(await drive!.service.listFolderGrants(caller, c.req.param("id")!, c.req.query("path") ?? "")),
  ));

  app.post("/api/spaces/:id/folder-grants", driveRoute(async (c, caller) => {
    const body = await c.req.json<{ path: string; subjectType: "user" | "space" | "email"; subjectId: string; role: "owner" | "editor" | "viewer" }>();
    if (!body.path || !body.subjectType || !body.subjectId || !body.role) return c.json({ error: "path, subjectType, subjectId, role required" }, 400);
    let grant: { subjectType: "user" | "space" | "email"; subjectId: string; role: "owner" | "editor" | "viewer" } = body;
    if (body.subjectType === "email") {
      const user = await drive!.service.resolveEmail(body.subjectId);
      if (user) grant = { ...grant, subjectType: "user", subjectId: user.sub };
    }
    await drive!.service.shareFolderGrant(caller, c.req.param("id")!, body.path, grant);
    return c.json({ ok: true }, 201);
  }));

  app.post("/api/spaces/:id/folder-grants/unshare", driveRoute(async (c, caller) => {
    const body = await c.req.json<{ path: string; subjectType: "user" | "space" | "email"; subjectId: string; role: "owner" | "editor" | "viewer" }>();
    await drive!.service.unshareFolderGrant(caller, c.req.param("id")!, body.path, body);
    return c.json({ ok: true });
  }));

  // Folders shared with the caller (direct or via a place), enriched with space name.
  app.get("/api/shared-folders", driveRoute(async (_c, caller) => {
    const folders = await drive!.service.listSharedFolders(caller.sub);
    const spaces = await drive!.service.spaces(caller.sub);
    const nameOf = new Map(spaces.map((s) => [s.id, s.name]));
    return _c.json(folders.map((f) => ({ ...f, spaceName: nameOf.get(f.spaceId) ?? "Shared" })));
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

  // ── MCP connections (which AI assistants connected, read-only) ──────────────
  // The MCP server is stateless, so this is recorded as a side effect of each
  // verified MCP request (see mcp/transport.ts) and just surfaced here for Settings.
  app.get("/api/mcp/connections", driveRoute(async (_c, caller) => _c.json(await drive!.service.listMcpClients(caller.sub))));

  // ── share links (unguessable secret → scoped capability; WebDAV + /s) ────────
  // A link's role is capped by the caller's own role on the target (see store).
  // The secret is returned ONCE on create. Files are keyed by file id; folders &
  // whole spaces by space id + optional ?path= (path present = folder).

  app.get("/api/files/:id/shares", driveRoute(async (c, caller) =>
    c.json(await drive!.service.listShares(caller, { objectType: "file", fileId: c.req.param("id")! })),
  ));
  app.post("/api/files/:id/shares", driveRoute(async (c, caller) => {
    const body = await c.req.json<{ role?: "viewer" | "editor"; label?: string; expiresAt?: string | null }>();
    const out = await drive!.service.createShare(
      caller,
      { objectType: "file", fileId: c.req.param("id")! },
      { role: body.role ?? "viewer", label: body.label, expiresAt: body.expiresAt ?? null },
    );
    return c.json(out, 201);
  }));

  app.get("/api/spaces/:id/shares", driveRoute(async (c, caller) => {
    const spaceId = c.req.param("id")!;
    const path = c.req.query("path") ?? "";
    const target = path ? { objectType: "folder" as const, spaceId, path } : { objectType: "space" as const, spaceId };
    return c.json(await drive!.service.listShares(caller, target));
  }));
  app.post("/api/spaces/:id/shares", driveRoute(async (c, caller) => {
    const spaceId = c.req.param("id")!;
    const body = await c.req.json<{ role?: "viewer" | "editor"; path?: string; label?: string; expiresAt?: string | null }>();
    const target = body.path ? { objectType: "folder" as const, spaceId, path: body.path } : { objectType: "space" as const, spaceId };
    const out = await drive!.service.createShare(caller, target, {
      role: body.role ?? "viewer",
      label: body.label,
      expiresAt: body.expiresAt ?? null,
    });
    return c.json(out, 201);
  }));

  app.delete("/api/shares/:id", driveRoute(async (c, caller) => {
    await drive!.service.revokeShare(caller, c.req.param("id")!);
    return c.json({ ok: true });
  }));

  // Public share landing: the secret in the path IS the credential (token-in-URL,
  // the convenient-but-logged path; WebDAV instead carries it in the Authorization
  // header). A file share streams the bytes; a folder/space share returns a
  // read-only JSON listing. Access runs as the share's creator.
  app.get("/s/:secret", (c) =>
    handle(c, async () => {
      if (!drive) return c.json({ error: "no drive configured" }, 404);
      const share = await drive.service.verifyShare(c.req.param("secret")!);
      if (!share) return c.json({ error: "invalid or expired link" }, 404);
      const asCreator = { sub: share.createdBy };
      if (share.objectType === "file" && share.fileId) {
        const [{ key, version }, file] = await Promise.all([
          drive.service.getContentKey(asCreator, share.fileId),
          drive.service.getFile(asCreator, share.fileId),
        ]);
        const stream = await drive.blobs.get(key);
        if (!stream) return c.json({ error: "not found" }, 404);
        c.header("Content-Type", version.mime ?? "application/octet-stream");
        c.header("Content-Length", String(version.size));
        c.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
        return c.body(stream);
      }
      const path = share.objectType === "folder" ? share.path : "";
      const listing = await drive.service.list(share.createdBy, share.spaceId, path);
      return c.json({ objectType: share.objectType, role: share.role, ...listing });
    }),
  );

  // ── plugin data sources (tasks / calendar) ──────────────────────────────────
  // A source's config is per-user (stored encrypted); `demoDefaults` is the
  // public fallback shown to everyone so the logged-out demo still has data.
  // The adapter owns its own caching (TTL) via the scoped cache it's handed.
  const sourcePlugins = dataSources?.plugins ?? [];
  const findSource = (id: string) => sourcePlugins.find((p) => p.id === id);
  // Any surface that has user-configurable settings: data sources, processors, and
  // the core "ai" provider config (Settings → AI models).
  const findConfigurable = (id: string): { id: string; configFields: ConnectorConfigField[] } | undefined =>
    findSource(id) ??
    processors.find((p) => p.id === id) ??
    (deps.aiUserConfig && id === AI_CONFIG_ID ? { id: AI_CONFIG_ID, configFields: deps.aiUserConfig.fields } : undefined);

  // The caller's **effective** AI gateway: their own UI-configured providers
  // (decrypted from per-user settings) layered over the deployment's base gateway,
  // so a personal key unlocks models for that caller only. User models list first.
  async function gatewayFor(sub?: string): Promise<AiGateway | undefined> {
    if (!deps.aiUserConfig || !sub) return ai;
    const config = await decryptedSettings(sub, { id: AI_CONFIG_ID, configFields: deps.aiUserConfig.fields });
    const userProviders = deps.aiUserConfig.build(config);
    if (userProviders.length === 0) return ai;
    // An AiGateway is structurally an AiProvider, so the base gateway composes in.
    return createAiGateway(ai ? [...userProviders, ai] : userProviders);
  }

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

  // Models available to the caller (base providers + their own UI-configured ones) —
  // powers plugin model pickers and the Settings → AI models panel.
  app.get("/api/ai/models", driveRoute(async (c, caller) => {
    const g = await gatewayFor(caller.sub);
    return c.json({ models: g ? g.models() : [] });
  }));

  // Run inference through the caller's effective gateway — the same surface the
  // Document AI processor uses, now reachable by trusted host UI (the Plugin
  // Studio). The caller never holds a provider key; the host routes by model id.
  // (This is the `ai:generate` grant the core anticipates; today only first-party
  // host UI calls it — sandboxed plugins don't reach it yet.)
  app.post("/api/ai/generate", driveRoute(async (c, caller) => {
    const g = await gatewayFor(caller.sub);
    const models = g?.models() ?? [];
    if (!g || models.length === 0) return c.json({ error: "no AI model is configured for this account" }, 503);
    const body = await c.req.json<{
      model?: string;
      messages?: AiMessage[];
      temperature?: number;
      maxTokens?: number;
      json?: boolean;
    }>();
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0) return c.json({ error: "messages required" }, 400);
    const model = body.model ?? models[0]!.id;
    if (!models.some((m) => m.id === model)) return c.json({ error: `unknown model "${model}"` }, 400);
    try {
      const result = await g.generate({
        model,
        messages,
        temperature: body.temperature,
        maxTokens: Math.min(body.maxTokens ?? 4096, AI_MAX_TOKENS),
        json: body.json,
      });
      return c.json(result);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  }));

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

  // ── scheduling: calendars, events, tasks (owned + aggregated) ───────────────
  // Reads aggregate the owned scheduling store (#34) with external data-source
  // providers (GitHub etc.) into one stream the calendar/tasks plugins render.
  // Owned items carry their calendar coordinates (spaceId/path/calendarId/color)
  // so the aggregator can group, color, and toggle by calendar; provider items
  // don't (they aren't space-scoped). Writes go through the dedicated routes below
  // and reuse the drive's folder-grant ACL via the scheduling store.

  /** Owned calendars the caller can see (= virtual folders), optionally one space. */
  app.get("/api/calendars", (c) =>
    handle(c, async () => {
      const caller = await callerOf(c);
      if (!caller || !scheduling) return c.json({ calendars: [] });
      return c.json({ calendars: await scheduling.listCalendars(caller, c.req.query("space") ?? undefined) });
    }),
  );

  /** Create a calendar in a space (a colored virtual folder). */
  app.post("/api/calendars", (c) =>
    handle(c, async () => {
      const caller = await callerOf(c);
      if (!caller) return c.json({ error: "unauthorized" }, 401);
      if (!scheduling || !drive) return c.json({ error: "scheduling unavailable" }, 503);
      const body = (await c.req.json()) as { name: string; path?: string; color?: string | null; space?: string };
      if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
      const spaceId = body.space ?? (await drive.service.personalSpace(caller.sub));
      const created = await scheduling.createCalendar(caller, { spaceId, name: body.name, path: body.path, color: body.color });
      return c.json(created, 201);
    }),
  );

  /** Share a calendar (folder) with a person by email. */
  app.post("/api/calendars/share", (c) =>
    handle(c, async () => {
      const caller = await callerOf(c);
      if (!caller) return c.json({ error: "unauthorized" }, 401);
      if (!scheduling) return c.json({ error: "scheduling unavailable" }, 503);
      const body = (await c.req.json()) as { space: string; path: string; email: string; role?: "viewer" | "editor" };
      await scheduling.shareCalendar(caller, body.space, body.path, body.email, body.role ?? "viewer");
      return c.json({ ok: true });
    }),
  );

  app.get("/api/tasks", (c) =>
    handle(c, async () => {
      const caller = await callerOf(c);
      // Owned tasks first (when signed in), then the GitHub provider's, so both
      // surface in the Tasks plugin. `source` reflects what contributed.
      const owned = caller && scheduling ? await scheduling.listTasks(caller, { spaceId: c.req.query("space") ?? undefined }) : [];
      const ownedTasks: Task[] = owned.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        due: t.due ?? undefined,
        labels: t.keywords,
        spaceId: t.spaceId,
        path: t.path,
        calendarId: `${t.spaceId}${t.path}`,
        editable: t.role !== "viewer",
      }));
      // A failing external provider must not sink the caller's own tasks.
      const resolved = await resolveConfig(c, "github");
      const provider = resolved ? providersFor("github", resolved).tasks : undefined;
      const ghTasks = provider ? await provider.listTasks().catch(() => []) : [];
      const source = ownedTasks.length ? (ghTasks.length ? "owned+github" : "owned") : ghTasks.length ? "github" : null;
      return c.json({ source, tasks: [...ownedTasks, ...ghTasks] });
    }),
  );

  app.get("/api/calendar", (c) =>
    handle(c, async () => {
      // Default window: 30 days back through 90 days ahead (covers releases + milestones).
      const now = Date.now();
      const from = c.req.query("from") ?? new Date(now - 30 * 864e5).toISOString();
      const to = c.req.query("to") ?? new Date(now + 90 * 864e5).toISOString();
      const caller = await callerOf(c);
      const space = c.req.query("space") ?? undefined;

      // Owned events, projected to the flat view shape with calendar coordinates.
      let ownedEvents: CalendarEvent[] = [];
      let calendars: Calendar[] = [];
      if (caller && scheduling) {
        calendars = await scheduling.listCalendars(caller, space);
        const colorOf = new Map(calendars.map((cal) => [`${cal.spaceId}${cal.path}`, cal.color ?? undefined]));
        const events = await scheduling.listEvents(caller, { range: { from, to }, spaceId: space });
        // A calendar view can't place a start-less (unscheduled) event, and
        // CalendarEvent.start must be non-empty, so drop those here.
        ownedEvents = events
          .filter((e) => e.start)
          .map((e) => {
            const calendarId = `${e.spaceId}${e.path}`;
            return {
              id: e.id,
              title: e.title,
              start: e.start as string,
              end: e.end ?? undefined,
              allDay: e.allDay,
              kind: "event",
              spaceId: e.spaceId,
              path: e.path,
              calendarId,
              color: colorOf.get(calendarId),
              editable: e.role !== "viewer",
            } satisfies CalendarEvent;
          });
      }

      // A failing external provider must not sink the caller's own events.
      const resolved = await resolveConfig(c, "github");
      const provider = resolved ? providersFor("github", resolved).calendar : undefined;
      const ghEvents = provider ? await provider.listEvents({ from, to }).catch(() => []) : [];
      const source = ownedEvents.length ? (ghEvents.length ? "owned+github" : "owned") : ghEvents.length ? "github" : null;
      return c.json({ source, events: [...ownedEvents, ...ghEvents], calendars });
    }),
  );

  /** Create an event in a calendar. */
  app.post("/api/events", (c) =>
    handle(c, async () => {
      const caller = await callerOf(c);
      if (!caller) return c.json({ error: "unauthorized" }, 401);
      if (!scheduling || !drive) return c.json({ error: "scheduling unavailable" }, 503);
      const body = (await c.req.json()) as Partial<EventInput> & { space?: string };
      const spaceId = body.spaceId ?? body.space ?? (await drive.service.personalSpace(caller.sub));
      if (!body.title) return c.json({ error: "title required" }, 400);
      const created = await scheduling.createEvent(caller, {
        spaceId,
        path: body.path,
        title: body.title,
        start: body.start,
        end: body.end,
        allDay: body.allDay,
        description: body.description,
        location: body.location,
        keywords: body.keywords,
      });
      return c.json(created, 201);
    }),
  );

  app.patch("/api/events/:id", (c) =>
    handle(c, async () => {
      const caller = await callerOf(c);
      if (!caller) return c.json({ error: "unauthorized" }, 401);
      if (!scheduling) return c.json({ error: "scheduling unavailable" }, 503);
      const body = (await c.req.json()) as Partial<EventInput>;
      return c.json({ updated: await scheduling.updateEvent(caller, c.req.param("id"), body) });
    }),
  );

  app.delete("/api/events/:id", (c) =>
    handle(c, async () => {
      const caller = await callerOf(c);
      if (!caller) return c.json({ error: "unauthorized" }, 401);
      if (!scheduling) return c.json({ error: "scheduling unavailable" }, 503);
      await scheduling.deleteEvent(caller, c.req.param("id"));
      return c.json({ ok: true });
    }),
  );

  /** Create a task in a calendar. */
  app.post("/api/tasks", (c) =>
    handle(c, async () => {
      const caller = await callerOf(c);
      if (!caller) return c.json({ error: "unauthorized" }, 401);
      if (!scheduling || !drive) return c.json({ error: "scheduling unavailable" }, 503);
      const body = (await c.req.json()) as Partial<TaskInput> & { space?: string };
      const spaceId = body.spaceId ?? body.space ?? (await drive.service.personalSpace(caller.sub));
      if (!body.title) return c.json({ error: "title required" }, 400);
      const invalid = invalidTaskField(body);
      if (invalid) return c.json({ error: invalid }, 400);
      const created = await scheduling.createTask(caller, {
        spaceId,
        path: body.path,
        title: body.title,
        status: body.status,
        progress: body.progress,
        start: body.start,
        due: body.due,
        priority: body.priority,
        keywords: body.keywords,
      });
      return c.json(created, 201);
    }),
  );

  app.patch("/api/tasks/:id", (c) =>
    handle(c, async () => {
      const caller = await callerOf(c);
      if (!caller) return c.json({ error: "unauthorized" }, 401);
      if (!scheduling) return c.json({ error: "scheduling unavailable" }, 503);
      const body = (await c.req.json()) as Partial<TaskInput>;
      const invalid = invalidTaskField(body);
      if (invalid) return c.json({ error: invalid }, 400);
      return c.json({ updated: await scheduling.updateTask(caller, c.req.param("id"), body) });
    }),
  );

  app.delete("/api/tasks/:id", (c) =>
    handle(c, async () => {
      const caller = await callerOf(c);
      if (!caller) return c.json({ error: "unauthorized" }, 401);
      if (!scheduling) return c.json({ error: "scheduling unavailable" }, 503);
      await scheduling.deleteTask(caller, c.req.param("id"));
      return c.json({ ok: true });
    }),
  );

  // ── per-user plugin settings (generic, schema-driven) ───────────────────────
  // The field schema is server-authoritative; secret values are encrypted at rest
  // and NEVER returned to the client (only whether each secret is set).

  // Fill a field's choices from a dynamic, host-owned source when serving the schema
  // (today: `optionsFrom: "ai-models"` → the caller's available AI models).
  const withDynamicOptions = (fields: ConnectorConfigField[], models: AiModel[]): ConnectorConfigField[] =>
    fields.map((f) =>
      f.optionsFrom === "ai-models"
        ? { ...f, options: models.map((m) => ({ value: m.id, label: `${m.label} · ${m.provider}` })) }
        : f,
    );

  app.get("/api/plugins/:id/settings", driveRoute(async (c, caller) => {
    const src = findConfigurable(c.req.param("id")!);
    if (!src) return c.json({ error: "unknown plugin" }, 404);
    const aiModels = src.configFields.some((f) => f.optionsFrom === "ai-models")
      ? ((await gatewayFor(caller.sub))?.models() ?? [])
      : [];
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
    return c.json({ fields: withDynamicOptions(src.configFields, aiModels), values, secretsSet });
  }));

  app.put("/api/plugins/:id/settings", driveRoute(async (c, caller) => {
    const src = findConfigurable(c.req.param("id")!);
    if (!src) return c.json({ error: "unknown plugin" }, 404);
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
    // On connect: if this is a connector-backed source that now resolves, kick a
    // background full index so the connected space populates without the user waiting.
    // Idempotent — re-saving settings just re-indexes (reconcile is an etag diff).
    if (deps.indexJobs && dataSources?.connectorFor && findSource(src.id)) {
      const resolved = await resolveConfig(c, src.id);
      const connector = resolved ? dataSources.connectorFor(src.id, resolved.config) : null;
      if (connector) {
        const spaceId = await drive!.service.ensureConnectorSpace(caller.sub, src.id, resolved!.config.repo ?? src.id);
        runBackground(deps.indexJobs.startConnectorIndex({ ownerSub: caller.sub, spaceId, pluginId: src.id }));
      }
    }
    return c.json({ ok: true });
  }));

  // Actively exercise a connector-backed plugin (Synology, etc.): build its
  // connector from the caller's saved config and attempt a root listing, so the
  // plugin's own page can show *why* a connection fails (bad credentials,
  // unreachable host, a QuickConnect that won't resolve) instead of silently
  // pretending it's connected the moment config exists. `connectorFor` covers the
  // "not configured" / "no connector" cases; the listing surfaces live failures.
  app.get("/api/plugins/:id/test", driveRoute(async (c) => {
    const pluginId = c.req.param("id")!;
    const resolved = await resolveConfig(c, pluginId);
    const connector = resolved && dataSources?.connectorFor ? dataSources.connectorFor(pluginId, resolved.config) : null;
    if (!connector) return c.json({ ok: false, error: "not configured" });
    try {
      await connector.list("");
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message });
    }
  }));

  // The places (group spaces the caller owns) a plugin can be applied to, each
  // flagged with whether it's applied there — for the "Applies to places" picker.
  app.get("/api/plugins/:id/places", driveRoute(async (c, caller) =>
    c.json({ places: await drive!.service.pluginPlaces(caller, c.req.param("id")!) }),
  ));

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

  // ── AI-generated plugins (Plugin Studio) ────────────────────────────────────
  // Plugins the caller authored at runtime via the core LLM. The host owns their
  // manifest + ESM source (they don't ship with the build); the client merges
  // them into its viewer/registry lists the way it would a resolved zip plugin.
  app.get("/api/plugins/custom", driveRoute(async (c, caller) => {
    const plugins = await drive!.service.listCustomPlugins(caller.sub);
    return c.json({
      plugins: plugins.map((p) => ({
        id: p.id,
        manifest: JSON.parse(p.manifest) as unknown,
        source: p.source,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
    });
  }));

  app.post("/api/plugins/custom", driveRoute(async (c, caller) => {
    const body = await c.req.json<{ manifest?: unknown; source?: unknown }>();
    const source = typeof body.source === "string" ? body.source : "";
    if (!source.trim()) return c.json({ error: "source required" }, 400);
    if (source.length > MAX_PLUGIN_SOURCE) return c.json({ error: "plugin source too large" }, 413);
    const err = validateCustomManifest(body.manifest);
    if (err) return c.json({ error: err }, 400);
    const manifest = body.manifest as { id: string };
    await drive!.service.addCustomPlugin(caller.sub, { id: manifest.id, manifest: JSON.stringify(manifest), source });
    return c.json({ ok: true, id: manifest.id }, 201);
  }));

  app.delete("/api/plugins/custom/:id", driveRoute(async (c, caller) => {
    await drive!.service.removeCustomPlugin(caller.sub, c.req.param("id")!);
    return c.json({ ok: true });
  }));

  // The caller's *effective* active set: their own installs (or the auth-dependent
  // default when nothing is saved) unioned with every plugin an owner has applied
  // to a space they belong to. This is what the portal renders the registry from.
  app.get("/api/plugins/active", driveRoute(async (c, caller) => {
    const stored = await drive!.service.getInstalledPlugins(caller.sub);
    const own = stored ?? (authConfig ? DEFAULT_PLUGINS : ANON_DEFAULT_PLUGINS);
    const applied = await drive!.service.spaceAppliedPlugins(caller.sub);
    return c.json({ ids: [...new Set([...own, ...applied])] });
  }));

  // WebDAV mount (read-only) — Basic auth via an app password, outside /api.
  if (drive) registerWebdav(app, drive);

  // Remote MCP server (search/fetch + read-write tools) for Claude & ChatGPT,
  // outside /api. OAuth bearer tokens from the OIDC provider; see ./mcp.
  if (drive) registerMcp(app, { drive, authConfig });

  return app;
}
