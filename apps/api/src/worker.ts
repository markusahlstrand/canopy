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
import { createApp } from "./app";
import { createAuthApp } from "./auth/routes";
import { readAuthConfig, type EnvVars } from "./auth/config";

/** Cloudflare Worker bindings + vars. */
interface WorkerEnv {
  /** R2 bucket holding content-addressed blobs. */
  BUCKET: R2BucketLike;
  /** D1 database holding file/version/blob/permission metadata. */
  DB: D1Like;
  /** GitHub repo ("owner/repo") backing the read-only docs + demo mounts. */
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
 * docs/demo are read-only GitHub mounts.
 */
export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const db = createD1Db(env.DB);
    await (schemaReady ??= runMigrations(db));

    const blobs = createR2BlobStore(env.BUCKET);
    const service = new FileService(db, blobs, createSqlBlobRepo(db));

    const readonlyMounts: Record<string, StorageConnector> = {};
    if (env.GITHUB_REPO) {
      const [owner, repo] = env.GITHUB_REPO.split("/");
      const gh = (id: string, basePath: string) =>
        createGithubConnector(id, { owner: owner!, repo: repo!, branch: env.GITHUB_BRANCH, basePath, token: env.GITHUB_TOKEN });
      readonlyMounts.docs = gh("docs", "docs");
      readonlyMounts.demo = gh("demo", "demo");
    }

    const onLogin = async (u: { sub: string; email?: string; name?: string; picture?: string }) => {
      await upsertUser(db, u);
      await resolveInvites(db, u.sub, u.email);
      await ensurePersonalSpace(db, u.sub);
    };

    const authConfig = readAuthConfig(env as unknown as EnvVars);
    const app = createApp({
      auth: createAuthApp(authConfig, onLogin),
      authConfig,
      readonlyMounts,
      drive: { service, blobs },
    });
    return app.fetch(request, env);
  },
};
