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
  createSqlSearchIndex,
  createSqlBlobRepo,
  ensurePersonalSpace,
  getPluginSettings,
  inProcessIndexJobs,
  resolveInvites,
  runMigrations,
  SchedulingStore,
  syncAllConnectors,
  upsertUser,
  type FileRecord,
  type FileVersion,
} from "@canopy/store";
import { createFsBlobStore, createLibsqlDb } from "@canopy/store/node";
import { createApp, type DataSourceDeps } from "./app";
import { SERVER_PLUGINS, dataSourcesOf, processorsOf } from "./plugins";
import { parseRepo, synologyConnectorFor } from "./data-sources";
import { documentTextExtractor } from "./extract";
import { inProcessDocWorker } from "@canopy/docworker";
import { readAuthConfig } from "./auth/config";
import { createAuthApp } from "./auth/routes";
import { decryptPluginConfig } from "./crypto";

// Load local secrets from the repo-root .dev.vars if present (Node 20.12+) —
// the same file `wrangler dev` reads, alongside wrangler.jsonc.
try {
  process.loadEnvFile(resolve(process.cwd(), "../../.dev.vars"));
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
const search = createSqlSearchIndex(db);

const authConfig = readAuthConfig();
if (authConfig && !authConfig.sessionSecret) {
  authConfig.sessionSecret = crypto.randomUUID() + crypto.randomUUID();
  console.warn("  ⚠ SESSION_SECRET not set — using an ephemeral key (sessions reset on restart)");
}

// Connector plumbing shared by the request path and the background sweep:
// `connectorFor` builds from a config; `connectorForUser` loads + decrypts a
// user's saved settings first; `readExternal` streams an external version's bytes
// (injected into FileService so downloads, the MCP read tools, and the extract
// queue all reach connector-backed files).
const sourcePlugins = dataSourcesOf(SERVER_PLUGINS);
const settingsSecret = authConfig?.sessionSecret ?? process.env.SESSION_SECRET;
const connectorFor = (pluginId: string, config: Record<string, string>): StorageConnector | null => {
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
};
const connectorForUser = async (sub: string, pluginId: string): Promise<StorageConnector | null> => {
  const fields = sourcePlugins.find((p) => p.id === pluginId)?.configFields ?? [];
  const config = await decryptPluginConfig(settingsSecret, fields, await getPluginSettings(db, sub, pluginId));
  return connectorFor(pluginId, config);
};
const readExternal = async (version: FileVersion, file: FileRecord): Promise<ReadableStream<Uint8Array> | null> => {
  if (!version.connectorId || !version.externalKey) return null;
  const connector = await connectorForUser(file.ownerId, version.connectorId);
  return connector ? connector.read(version.externalKey) : null;
};

const service = new FileService(db, blobs, createSqlBlobRepo(db), {
  globalDedup: process.env.CANOPY_GLOBAL_DEDUP === "1",
  index: search,
  textExtractor: documentTextExtractor,
  readExternal,
});
// Backfill the full-text index for any files that predate it (idempotent).
void service
  .reindexAll()
  .then((r) => r.indexed && console.log(`  ↻ search: indexed ${r.indexed} existing file(s)`))
  .catch((err) => console.warn(`  ⚠ search backfill failed: ${(err as Error).message}`));

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
  plugins: sourcePlugins,
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
  secret: settingsSecret,
  // Browse a connected backend live as a space (GitHub repo / Synology NAS).
  connectorFor,
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
  drive: { service, blobs, docWorker: inProcessDocWorker() },
  scheduling: new SchedulingStore(db),
  dataSources,
  // In-process connector indexing (full crawl + extract drain) for the "Sync now" /
  // on-connect triggers; the periodic sweep below stays the safety net.
  indexJobs: inProcessIndexJobs({ db, service, connectorForUser }),
  // libsql FTS5 search index (same SQL adapter as D1 on the edge).
  search,
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

// Periodic version-retention sweep (#11): thin old snapshots down to the retention
// curve, releasing pruned blobs. Cloudflare runs this from a Cron Trigger (see
// worker.ts `scheduled`); the single Node process runs it on an in-process interval.
// `.unref()` so the timer never keeps the process alive on its own.
const PRUNE_INTERVAL_MS = 6 * 60 * 60_000; // every 6 hours
setInterval(() => {
  void service.pruneAllVersions().catch((err) => console.warn("  ⚠ version prune failed:", err));
  void service.pruneTombstones().catch((err) => console.warn("  ⚠ tombstone prune failed:", err));
}, PRUNE_INTERVAL_MS).unref();

// Periodic connected-backend sweep: refresh each user's persisted NAS/repo index
// from the connector (incremental via its change feed, else a crawl) + drain text
// extraction. The edge runs the same sweep from `scheduled` (worker.ts). A short
// initial run after boot warms the index without blocking startup.
const SYNC_INTERVAL_MS = 30 * 60_000; // every 30 minutes
const sweep = () =>
  void syncAllConnectors({ db, service, connectorForUser }).catch((err) =>
    console.warn("  ⚠ connector sweep failed:", err),
  );
setTimeout(sweep, 15_000).unref();
setInterval(sweep, SYNC_INTERVAL_MS).unref();
