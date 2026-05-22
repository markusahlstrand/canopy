import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { createLocalConnector } from "@canopy/connector-local";
import { createGithubConnector } from "@canopy/connector-github";
import type { StorageConnector } from "@canopy/core";
import { FileService, createSqlBlobRepo, ensurePersonalSpace, resolveInvites, runMigrations, upsertUser } from "@canopy/store";
import { createFsBlobStore, createLibsqlDb } from "@canopy/store/node";
import { createApp } from "./app";
import { readAuthConfig } from "./auth/config";
import { createAuthApp } from "./auth/routes";

// Load local secrets from apps/api/.dev.vars if present (Node 20.12+).
try {
  process.loadEnvFile(resolve(process.cwd(), ".dev.vars"));
} catch {
  // no .dev.vars — fall back to the ambient environment
}

// Drive data root: the SQLite DB + content-addressed blobs live here (gitignored).
const dataRoot = process.env.CANOPY_LOCAL_ROOT
  ? resolve(process.env.CANOPY_LOCAL_ROOT)
  : resolve(process.cwd(), "../../storage");
mkdirSync(dataRoot, { recursive: true });
const dbPath = resolve(dataRoot, "canopy.db");
const blobsRoot = resolve(dataRoot, "blobs");

// docs + demo are read-only mounts — from GitHub when GITHUB_REPO is set, else local.
const docsRoot = resolve(process.cwd(), "../../docs");
const demoRoot = resolve(process.cwd(), "../../demo");
const ghRepo = process.env.GITHUB_REPO; // "owner/repo"
const [ghOwner, ghName] = (ghRepo ?? "").split("/");
const ghBranch = process.env.GITHUB_BRANCH || "main";
const ghToken = process.env.GITHUB_TOKEN;
const fromGithub = (id: string, basePath: string): StorageConnector =>
  createGithubConnector(id, { owner: ghOwner!, repo: ghName!, branch: ghBranch, basePath, token: ghToken });
const docs = ghRepo ? fromGithub("docs", "docs") : createLocalConnector("docs", docsRoot);
const demo = ghRepo ? fromGithub("demo", "demo") : createLocalConnector("demo", demoRoot);

// The drive: libsql (SQLite) metadata + filesystem blob store.
const db = createLibsqlDb(`file:${dbPath}`);
await runMigrations(db);
const blobs = createFsBlobStore(blobsRoot);
const service = new FileService(db, blobs, createSqlBlobRepo(db), {
  globalDedup: process.env.CANOPY_GLOBAL_DEDUP === "1",
});

const authConfig = readAuthConfig();
if (authConfig && !authConfig.sessionSecret) {
  authConfig.sessionSecret = crypto.randomUUID() + crypto.randomUUID();
  console.warn("  ⚠ SESSION_SECRET not set — using an ephemeral key (sessions reset on restart)");
}

// On login: record the user in the directory, resolve pending email invites,
// and ensure their personal space exists.
const onLogin = async (u: { sub: string; email?: string; name?: string; picture?: string; emailVerified?: boolean }) => {
  await upsertUser(db, u);
  // Only resolve email invites for a verified address — otherwise someone could
  // claim an invite by signing up with another person's email.
  if (u.emailVerified) await resolveInvites(db, u.sub, u.email);
  await ensurePersonalSpace(db, u.sub);
};

const app = createApp({
  auth: createAuthApp(authConfig, onLogin),
  authConfig,
  readonlyMounts: { docs, demo },
  drive: { service, blobs },
});

// Single-process mode: if the built SPA exists, serve it from this same server.
const distDir = resolve(process.cwd(), "../portal/dist");
const serveSpa = existsSync(distDir);
if (serveSpa) {
  app.get("/*", serveStatic({ root: "../portal/dist" }));
  app.get("*", serveStatic({ path: "../portal/dist/index.html" })); // SPA fallback
}

const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`canopy api → http://localhost:${info.port}`);
  console.log(`  drive       → sqlite:${dbPath} + blobs:${blobsRoot} (per-user)`);
  console.log(`  docs + demo → ${ghRepo ? `github:${ghRepo}@${ghBranch}` : `${docsRoot} / ${demoRoot}`}`);
  console.log(`  auth        → ${authConfig ? authConfig.issuer : "not configured (anonymous)"}`);
  console.log(`  ui          → ${serveSpa ? distDir : "served by Vite (dev)"}`);
});
