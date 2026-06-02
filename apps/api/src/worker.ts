import { createAiGateway, type StorageConnector } from "@canopy/core";
import { createGithubConnector } from "@canopy/connector-github";
import { createCloudflareAi, type WorkersAiBinding } from "./ai/cloudflare";
import { AI_PROVIDER_FIELDS, providersFromUserConfig } from "./ai/user-config";
import {
  FileService,
  createD1Db,
  createR2BlobStore,
  createSqlBlobRepo,
  createSqlSearchIndex,
  ensurePersonalSpace,
  getPluginSettings,
  resolveInvites,
  runMigrations,
  syncAllConnectors,
  upsertUser,
  type Db,
  type D1Like,
  type FileRecord,
  type FileVersion,
  type R2BucketLike,
} from "@canopy/store";
import { createApp, type DataSourceDeps } from "./app";
import { SERVER_PLUGINS, dataSourcesOf, processorsOf } from "./plugins";
import { parseRepo, synologyConnectorFor } from "./data-sources";
import { documentTextExtractor } from "./extract";
import { inProcessDocWorker } from "@canopy/docworker";
import { containerDocWorker, type ContainerNamespace } from "./extract-container";
import { createContainerSynologyConnector } from "./synology-container";
import { createCacheApiCacheStore } from "./cache-api";
import { decryptPluginConfig } from "./crypto";
import { createAuthApp } from "./auth/routes";
import { readAuthConfig, type AuthConfig, type EnvVars } from "./auth/config";

/** Cloudflare Worker bindings + vars. */
interface WorkerEnv {
  /** R2 bucket holding content-addressed blobs. */
  BUCKET: R2BucketLike;
  /** D1 database holding file/version/blob/permission metadata. */
  DB: D1Like;
  /** Workers AI binding — when bound, the host exposes its models (Gemma) with no key. */
  AI?: WorkersAiBinding;
  /** GitHub repo ("owner/repo") backing the read-only documentation + demo mounts. */
  GITHUB_REPO?: string;
  GITHUB_BRANCH?: string;
  GITHUB_TOKEN?: string;
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_REDIRECT_URI?: string;
  OIDC_SCOPES?: string;
  APP_BASE_URL?: string;
  SESSION_SECRET?: string;
  SESSION_TTL?: string;
  /** Durable Object namespace for the document-parser container (optional offload). */
  DOCWORKER?: ContainerNamespace;
  /** Shared secret the Worker sends to the container; also injected into the container. */
  DOCWORKER_TOKEN?: string;
}

// Apply the schema once per isolate (CREATE TABLE IF NOT EXISTS is idempotent).
let schemaReady: Promise<void> | undefined;

/**
 * Build the connector plumbing shared by the request path and the background
 * (scheduled) path: `connectorFor` (config → connector, container path included),
 * `connectorForUser` (loads + decrypts a user's saved settings, then builds), and
 * `readExternal` (streams an external version's bytes — injected into FileService
 * so the download route, the MCP read tools, and the extract queue all reach
 * connector-backed files). Defined once so the cron and the app never drift.
 */
function connectorWiring(env: WorkerEnv, db: Db, authConfig: AuthConfig | null) {
  const plugins = dataSourcesOf(SERVER_PLUGINS);
  const connectorFor = (pluginId: string, config: Record<string, string>): StorageConnector | null => {
    if (pluginId === "synology") {
      // From the edge a tailnet NAS is only reachable *through the container* (which
      // joins the user's tailnet with their per-user key); otherwise direct/QuickConnect.
      return env.DOCWORKER && config.tailscaleHost && config.tailscaleAuthKey
        ? createContainerSynologyConnector(env.DOCWORKER, config)
        : synologyConnectorFor(config);
    }
    if (pluginId !== "github") return null;
    const p = parseRepo(config.repo ?? "");
    return p
      ? createGithubConnector("connector:github", {
          owner: p.owner,
          repo: p.repo,
          branch: config.branch || undefined,
          token: config.token || undefined,
        })
      : null;
  };
  const connectorForUser = async (sub: string, pluginId: string): Promise<StorageConnector | null> => {
    const fields = plugins.find((p) => p.id === pluginId)?.configFields ?? [];
    const config = await decryptPluginConfig(authConfig?.sessionSecret, fields, await getPluginSettings(db, sub, pluginId));
    return connectorFor(pluginId, config);
  };
  const readExternal = async (version: FileVersion, file: FileRecord): Promise<ReadableStream<Uint8Array> | null> => {
    if (!version.connectorId || !version.externalKey) return null;
    const connector = await connectorForUser(file.ownerId, version.connectorId);
    return connector ? connector.read(version.externalKey) : null;
  };
  return { plugins, connectorFor, connectorForUser, readExternal };
}

/**
 * Single Cloudflare Worker: serves /api/* (the Hono app); everything else comes
 * from Static Assets. The drive is D1 (metadata) + R2 (content-addressed blobs);
 * documentation/demo are read-only GitHub mounts.
 */
export default {
  async fetch(request: Request, env: WorkerEnv, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const db = createD1Db(env.DB);
    await (schemaReady ??= runMigrations(db));

    const blobs = createR2BlobStore(env.BUCKET);
    const search = createSqlSearchIndex(db);
    const authConfig = readAuthConfig(env as unknown as EnvVars);
    const { plugins, connectorFor, readExternal } = connectorWiring(env, db, authConfig);
    const service = new FileService(db, blobs, createSqlBlobRepo(db), {
      index: search,
      textExtractor: documentTextExtractor,
      readExternal,
    });

    const readonlyMounts: Record<string, StorageConnector> = {};
    let demoDefaults: Record<string, Record<string, string>> = {};
    if (env.GITHUB_REPO) {
      const [owner, repo] = env.GITHUB_REPO.split("/");
      const cfg = { owner: owner!, repo: repo!, branch: env.GITHUB_BRANCH, token: env.GITHUB_TOKEN };
      const gh = (id: string, basePath: string) => createGithubConnector(id, { ...cfg, basePath });
      readonlyMounts.documentation = gh("documentation", "documentation");
      readonlyMounts.demo = gh("demo", "demo");
      // Env GITHUB_REPO/TOKEN = the public demo default for tasks (issues) and
      // calendar (milestones + releases), until a user connects their own repo.
      demoDefaults = {
        github: {
          repo: env.GITHUB_REPO,
          ...(env.GITHUB_BRANCH ? { branch: env.GITHUB_BRANCH } : {}),
          ...(env.GITHUB_TOKEN ? { token: env.GITHUB_TOKEN } : {}),
        },
      };
    }

    const onLogin = async (u: { sub: string; email?: string; name?: string; picture?: string; emailVerified?: boolean }) => {
      await upsertUser(db, u);
      if (u.emailVerified) await resolveInvites(db, u.sub, u.email); // verified email only
      await ensurePersonalSpace(db, u.sub);
    };

    const dataSources: DataSourceDeps = {
      plugins,
      demoDefaults,
      cache: createCacheApiCacheStore(),
      secret: authConfig?.sessionSecret,
      // Browse a connected backend live as a space (GitHub repo / Synology NAS).
      connectorFor,
    };
    // Workers AI (env.AI) is the host AI gateway on Cloudflare — Gemma & co. with no
    // per-user key. Absent (e.g. the binding isn't configured), no host models exist.
    const ai = env.AI ? createAiGateway([createCloudflareAi(env.AI)]) : undefined;

    const app = createApp({
      auth: createAuthApp(authConfig, onLogin),
      authConfig,
      readonlyMounts,
      // Parse in-process by default (pure-JS unpdf + SheetJS in the isolate). When the
      // container is bound, offload to it instead — the only path that can reach a
      // tailnet-only source. The DO binding is the auth boundary (a container has no
      // public ingress), so no shared secret is required; DOCWORKER_TOKEN is optional
      // defense-in-depth. Same adapter either way.
      drive: {
        service,
        blobs,
        docWorker: env.DOCWORKER ? containerDocWorker(env.DOCWORKER, env.DOCWORKER_TOKEN) : inProcessDocWorker(),
      },
      dataSources,
      // D1 FTS5 search index — the same SQL adapter as libsql on Node.
      search,
      processors: processorsOf(SERVER_PLUGINS),
      ai,
      // Let users add their own Gemini / OpenAI-compatible keys in Settings → AI models.
      aiUserConfig: { fields: AI_PROVIDER_FIELDS, build: providersFromUserConfig },
      waitUntil: (p) => ctx.waitUntil(p), // keep AI labeling alive after the response
    });
    return app.fetch(request, env);
  },

  /**
   * Cron Trigger (see wrangler.jsonc `triggers.crons`): thins each file's version
   * history to the retention curve (#11), then sweeps connected backends — refreshing
   * each user's persisted NAS/repo index from the connector (incremental via the
   * change feed when available, else a bounded crawl) and draining text extraction.
   */
  async scheduled(_event: { cron: string }, env: WorkerEnv, _ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    const db = createD1Db(env.DB);
    await (schemaReady ??= runMigrations(db));
    const blobs = createR2BlobStore(env.BUCKET);
    const search = createSqlSearchIndex(db);
    const authConfig = readAuthConfig(env as unknown as EnvVars);
    const { connectorForUser, readExternal } = connectorWiring(env, db, authConfig);
    const service = new FileService(db, blobs, createSqlBlobRepo(db), {
      index: search,
      textExtractor: documentTextExtractor,
      readExternal,
    });
    await service.pruneAllVersions();
    await syncAllConnectors({ db, service, connectorForUser }, "synology");
  },
};
