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
  resolveInvites,
  runMigrations,
  upsertUser,
  type D1Like,
  type R2BucketLike,
} from "@canopy/store";
import { createApp, type DataSourceDeps } from "./app";
import { SERVER_PLUGINS, dataSourcesOf, processorsOf } from "./plugins";
import { parseRepo, synologyConnectorFor } from "./data-sources";
import { documentTextExtractor } from "./extract";
import { createCacheApiCacheStore } from "./cache-api";
import { createAuthApp } from "./auth/routes";
import { readAuthConfig, type EnvVars } from "./auth/config";

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
}

// Apply the schema once per isolate (CREATE TABLE IF NOT EXISTS is idempotent).
let schemaReady: Promise<void> | undefined;

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
    const service = new FileService(db, blobs, createSqlBlobRepo(db), { index: search, textExtractor: documentTextExtractor });

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

    const authConfig = readAuthConfig(env as unknown as EnvVars);
    const dataSources: DataSourceDeps = {
      plugins: dataSourcesOf(SERVER_PLUGINS),
      demoDefaults,
      cache: createCacheApiCacheStore(),
      secret: authConfig?.sessionSecret,
      // Browse a connected backend live as a space: a GitHub repo, or a Synology
      // NAS over FileStation. From the edge only QuickConnect relay / a public
      // HTTPS endpoint is reachable — a LAN address or self-signed cert is not.
      connectorFor: (pluginId, config) => {
        if (pluginId === "synology") return synologyConnectorFor(config);
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
      },
    };
    // Workers AI (env.AI) is the host AI gateway on Cloudflare — Gemma & co. with no
    // per-user key. Absent (e.g. the binding isn't configured), no host models exist.
    const ai = env.AI ? createAiGateway([createCloudflareAi(env.AI)]) : undefined;

    const app = createApp({
      auth: createAuthApp(authConfig, onLogin),
      authConfig,
      readonlyMounts,
      drive: { service, blobs },
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
   * Cron Trigger (see wrangler.jsonc `triggers.crons`): a periodic sweep that thins
   * each file's version history down to the tiered retention curve (#11), releasing
   * the blobs of pruned snapshots. Pinned and current versions are always kept.
   */
  async scheduled(_event: { cron: string }, env: WorkerEnv, _ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    const db = createD1Db(env.DB);
    await (schemaReady ??= runMigrations(db));
    const service = new FileService(db, createR2BlobStore(env.BUCKET), createSqlBlobRepo(db));
    await service.pruneAllVersions();
  },
};
