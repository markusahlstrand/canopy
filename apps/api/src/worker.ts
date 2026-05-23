import type { StorageConnector } from "@canopy/core";
import { createGithubConnector } from "@canopy/connector-github";
import {
  FileService,
  createD1Db,
  createR2BlobStore,
  createSqlBlobRepo,
  ensurePersonalSpace,
  resolveInvites,
  runMigrations,
  upsertUser,
  type D1Like,
  type R2BucketLike,
} from "@canopy/store";
import { createApp, type DataSourceDeps } from "./app";
import { DATA_SOURCES } from "./data-sources";
import { PROCESSORS } from "./processors";
import { createCacheApiCacheStore } from "./cache-api";
import { createAuthApp } from "./auth/routes";
import { readAuthConfig, type EnvVars } from "./auth/config";

/** Cloudflare Worker bindings + vars. */
interface WorkerEnv {
  /** R2 bucket holding content-addressed blobs. */
  BUCKET: R2BucketLike;
  /** D1 database holding file/version/blob/permission metadata. */
  DB: D1Like;
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
    const service = new FileService(db, blobs, createSqlBlobRepo(db));

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
      plugins: DATA_SOURCES,
      demoDefaults,
      cache: createCacheApiCacheStore(),
      secret: authConfig?.sessionSecret,
    };
    const app = createApp({
      auth: createAuthApp(authConfig, onLogin),
      authConfig,
      readonlyMounts,
      drive: { service, blobs },
      dataSources,
      processors: PROCESSORS,
      waitUntil: (p) => ctx.waitUntil(p), // keep AI labeling alive after the response
    });
    return app.fetch(request, env);
  },
};
