import type { StorageConnector } from "@canopy/core";
import { createR2Connector, type R2BucketLike } from "@canopy/connector-r2";
import { createGithubConnector } from "@canopy/connector-github";
import { createApp } from "./app";
import { createAuthApp } from "./auth/routes";
import { readAuthConfig, type EnvVars } from "./auth/config";

/** Cloudflare Worker bindings + vars. */
interface WorkerEnv {
  /** R2 bucket for the user's drive (the "local" mount). */
  BUCKET: R2BucketLike;
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

/**
 * Single Cloudflare Worker: serves /api/* (the Hono app), while everything else
 * is served from Static Assets (the built SPA) — see wrangler.jsonc
 * `run_worker_first: ["/api/*"]`. Storage is R2; the same `app.ts` runs here and
 * on Node.
 */
export default {
  fetch(request: Request, env: WorkerEnv): Response | Promise<Response> {
    const connectors: Record<string, StorageConnector> = {
      local: createR2Connector("local", env.BUCKET),
    };
    if (env.GITHUB_REPO) {
      const [owner, repo] = env.GITHUB_REPO.split("/");
      const gh = (id: string, basePath: string) =>
        createGithubConnector(id, { owner: owner!, repo: repo!, branch: env.GITHUB_BRANCH, basePath, token: env.GITHUB_TOKEN });
      connectors.docs = gh("docs", "docs");
      connectors.demo = gh("demo", "demo");
    }

    const authConfig = readAuthConfig(env as unknown as EnvVars);
    const app = createApp(connectors, { auth: createAuthApp(authConfig), authConfig });
    return app.fetch(request, env);
  },
};
