import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createLocalConnector } from "@canopy/connector-local";
import { createGithubConnector } from "@canopy/connector-github";
import type { StorageConnector } from "@canopy/core";
import { createApp } from "./app";
import { readAuthConfig } from "./auth/config";
import { createAuthApp } from "./auth/routes";

// Load local secrets from apps/api/.dev.vars if present (Node 20.12+).
try {
  process.loadEnvFile(resolve(process.cwd(), ".dev.vars"));
} catch {
  // no .dev.vars — fall back to the ambient environment
}

const driveRoot = process.env.CANOPY_LOCAL_ROOT
  ? resolve(process.env.CANOPY_LOCAL_ROOT)
  : resolve(process.cwd(), "../../storage");
const docsRoot = resolve(process.cwd(), "../../docs");
const demoRoot = resolve(process.cwd(), "../../demo");

// docs + demo come from GitHub when GITHUB_REPO is set (so they aren't bundled);
// otherwise the in-repo folders are used as a dev fallback.
const ghRepo = process.env.GITHUB_REPO; // "owner/repo"
const [ghOwner, ghName] = (ghRepo ?? "").split("/");
const ghBranch = process.env.GITHUB_BRANCH || "main";
const ghToken = process.env.GITHUB_TOKEN;
const fromGithub = (id: string, basePath: string): StorageConnector =>
  createGithubConnector(id, { owner: ghOwner!, repo: ghName!, branch: ghBranch, basePath, token: ghToken });

const docsConnector = ghRepo ? fromGithub("docs", "docs") : createLocalConnector("docs", docsRoot);
const demoConnector = ghRepo ? fromGithub("demo", "demo") : createLocalConnector("demo", demoRoot);

const authConfig = readAuthConfig();
if (authConfig && !authConfig.sessionSecret) {
  authConfig.sessionSecret = crypto.randomUUID() + crypto.randomUUID();
  console.warn("  ⚠ SESSION_SECRET not set — using an ephemeral key (sessions reset on restart)");
}
const app = createApp(
  {
    local: createLocalConnector("local", driveRoot),
    docs: docsConnector,
    demo: demoConnector,
  },
  { auth: createAuthApp(authConfig), authConfig },
);
// Single-process mode: if the built SPA exists, serve it from this same server
// (UI + API on one port). In normal dev the UI is served by Vite, so dist is
// absent and this is skipped.
const distDir = resolve(process.cwd(), "../portal/dist");
const serveSpa = existsSync(distDir);
if (serveSpa) {
  app.get("/*", serveStatic({ root: "../portal/dist" }));
  app.get("*", serveStatic({ path: "../portal/dist/index.html" })); // SPA fallback
}

const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`canopy api → http://localhost:${info.port}`);
  console.log(`  drive       → ${driveRoot} (per-user)`);
  console.log(`  docs + demo → ${ghRepo ? `github:${ghRepo}@${ghBranch}` : `${docsRoot} / ${demoRoot}`}`);
  console.log(`  auth        → ${authConfig ? authConfig.issuer : "not configured (anonymous)"}`);
  console.log(`  ui          → ${serveSpa ? distDir : "served by Vite (dev)"}`);
});
