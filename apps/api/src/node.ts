import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { createLocalConnector } from "@canopy/connector-local";
import { createGithubConnector } from "@canopy/connector-github";
import { createAiGateway, type AiProvider, type StorageConnector } from "@canopy/core";
import { createGeminiAi } from "./ai/gemini";
import { createOpenAiCompatAi, parseModelSpecs } from "./ai/openai-compat";
import { AI_PROVIDER_FIELDS, providersFromUserConfig } from "./ai/user-config";
import {
  FileService,
  createSqlCacheStore,
  createSqlBlobRepo,
  ensurePersonalSpace,
  resolveInvites,
  runMigrations,
  upsertUser,
} from "@canopy/store";
import { createFsBlobStore, createLibsqlDb } from "@canopy/store/node";
import { createApp, type DataSourceDeps } from "./app";
import { SERVER_PLUGINS, dataSourcesOf, processorsOf } from "./plugins";
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

// documentation + demo are read-only mounts — from GitHub when GITHUB_REPO is set, else local.
const documentationRoot = resolve(process.cwd(), "../../documentation");
const demoRoot = resolve(process.cwd(), "../../demo");
const ghRepo = process.env.GITHUB_REPO; // "owner/repo"
const [ghOwner, ghName] = (ghRepo ?? "").split("/");
const ghBranch = process.env.GITHUB_BRANCH || "main";
const ghToken = process.env.GITHUB_TOKEN;
const fromGithub = (id: string, basePath: string): StorageConnector =>
  createGithubConnector(id, { owner: ghOwner!, repo: ghName!, branch: ghBranch, basePath, token: ghToken });
const documentation = ghRepo
  ? fromGithub("documentation", "documentation")
  : createLocalConnector("documentation", documentationRoot);
const demo = ghRepo ? fromGithub("demo", "demo") : createLocalConnector("demo", demoRoot);

// GitHub also feeds the tasks (issues) and calendar (milestones + releases) plugins.
const githubCfg = ghRepo ? { owner: ghOwner!, repo: ghName!, branch: ghBranch, token: ghToken } : null;

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

const dataSources: DataSourceDeps = {
  plugins: dataSourcesOf(SERVER_PLUGINS),
  // Env GITHUB_REPO/TOKEN = the public demo default (shown to everyone until a
  // user connects their own repo in the GitHub plugin's settings).
  demoDefaults: githubCfg
    ? {
        github: {
          repo: `${githubCfg.owner}/${githubCfg.repo}`,
          ...(githubCfg.branch ? { branch: githubCfg.branch } : {}),
          ...(githubCfg.token ? { token: githubCfg.token } : {}),
        },
      }
    : {},
  cache: createSqlCacheStore(db),
  // Encrypts stored secrets (provider keys, tokens) at rest. Falls back to a bare
  // SESSION_SECRET so the UI can save keys in dev even with auth/OIDC switched off.
  secret: authConfig?.sessionSecret ?? process.env.SESSION_SECRET,
};

// AI providers off Node env (no Workers AI binding here): a Gemini key, and/or any
// OpenAI-compatible endpoint — including a local model (Ollama, LM Studio) so Gemma
// can back Document AI in dev. The union of their models is what plugins see.
const aiProviders: AiProvider[] = [];
if (process.env.GOOGLE_AI_API_KEY) aiProviders.push(createGeminiAi(process.env.GOOGLE_AI_API_KEY));
if (process.env.OPENAI_BASE_URL) {
  const models = parseModelSpecs(process.env.OPENAI_MODELS);
  if (models.length) {
    aiProviders.push(
      createOpenAiCompatAi({
        baseUrl: process.env.OPENAI_BASE_URL,
        apiKey: process.env.OPENAI_API_KEY,
        label: process.env.OPENAI_LABEL,
        models,
      }),
    );
  } else {
    console.warn("  ⚠ OPENAI_BASE_URL set but OPENAI_MODELS is empty — no local models exposed");
  }
}
const ai = aiProviders.length ? createAiGateway(aiProviders) : undefined;

const app = createApp({
  auth: createAuthApp(authConfig, onLogin),
  authConfig,
  readonlyMounts: { documentation, demo },
  drive: { service, blobs },
  dataSources,
  processors: processorsOf(SERVER_PLUGINS),
  ai,
  // Let users add their own Gemini / OpenAI-compatible keys in Settings → AI models.
  aiUserConfig: { fields: AI_PROVIDER_FIELDS, build: providersFromUserConfig },
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
  console.log(`  documentation + demo → ${ghRepo ? `github:${ghRepo}@${ghBranch}` : `${documentationRoot} / ${demoRoot}`}`);
  console.log(`  auth        → ${authConfig ? authConfig.issuer : "not configured (anonymous)"}`);
  console.log(`  ai          → ${ai ? ai.models().map((m) => m.id).join(", ") : "no providers (set GOOGLE_AI_API_KEY or OPENAI_BASE_URL)"}`);
  console.log(`  ui          → ${serveSpa ? distDir : "served by Vite (dev)"}`);
});
