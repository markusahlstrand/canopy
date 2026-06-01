import { Hono, type Context } from "hono";
import { inProcessDocWorker, type TextWindow } from "@canopy/docworker";
import type { SynologyConfig } from "@canopy/connector-synology";
import { basename, readSynologyBytes, synologyConnector, type SynologySource } from "./sources";
import { ensureTailnetReady } from "./tailnet";

/**
 * The document-parsing HTTP service. Wraps {@link inProcessDocWorker} (the same
 * pure-JS parser used in-process on Node and in the Workers isolate) behind a
 * small API, and adds the one thing a Worker can't do: read a tailnet-only
 * Synology source itself (via the Tailscale sidecar) before parsing.
 *
 * Two source shapes:
 *   • inline  — raw bytes in the request body (the API Worker streams R2 bytes
 *               here to offload heavy parsing); name/mime via headers.
 *   • synology — a `{ config, path }` descriptor the service fetches over the
 *               tailnet, then parses.
 *
 * Auth is a shared secret (`X-Docworker-Token`) — the service is only ever
 * reached over the internal Worker→container hop, never publicly.
 */
export function createDocWorkerApp(opts: { token?: string } = {}): Hono {
  const app = new Hono();
  const worker = inProcessDocWorker();

  // Surface the real error instead of an opaque 500 — the body propagates back
  // through the Worker's delegating connector so failures are debuggable.
  app.onError((err, c) => {
    console.error("[docworker]", err);
    return c.json({ error: (err as Error).message || "internal error" }, 502);
  });

  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    if (opts.token && c.req.header("x-docworker-token") !== opts.token) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // ── inline bytes (Worker streams R2 content here) ──────────────────────────
  app.post("/extract", async (c) => {
    const { name, mime } = docMeta(c);
    const bytes = await body(c);
    const win: TextWindow = { offset: intQuery(c, "offset"), limit: intQuery(c, "limit") };
    return c.json(await worker.extractText(bytes, name, mime, win));
  });

  app.post("/extract/tables", async (c) => {
    const { name, mime } = docMeta(c);
    return c.json(await worker.extractTables(await body(c), name, mime));
  });

  app.post("/extract/outline", async (c) => {
    const { name, mime } = docMeta(c);
    return c.json(await worker.extractOutline(await body(c), name, mime));
  });

  // ── tailnet source: read the NAS bytes here, then parse ────────────────────
  app.post("/synology/extract", async (c) => {
    const req = (await c.req.json()) as {
      source: SynologySource;
      format?: "text" | "tables" | "outline";
      offset?: number;
      limit?: number;
      name?: string;
      mime?: string;
    };
    const bytes = await readSynologyBytes(req.source);
    if (!bytes) return c.json({ error: "source too large or unreadable", truncated: true }, 413);
    const name = req.name ?? basename(req.source.path);
    const mime = req.mime ?? null;
    if (req.format === "tables") return c.json(await worker.extractTables(bytes, name, mime));
    if (req.format === "outline") return c.json(await worker.extractOutline(bytes, name, mime));
    return c.json(await worker.extractText(bytes, name, mime, { offset: req.offset, limit: req.limit }));
  });

  // ── tailnet source: the full StorageConnector surface, proxied over the tailnet ──
  // The API Worker's edge connector forwards each call here; we rebuild the real
  // Synology connector with a tailnet-routed fetch and call through. `ensureTailnetReady`
  // gates on the sidecar so a cold-started instance doesn't race the handshake.
  app.post("/synology/list", async (c) => {
    const { config, path, cursor, limit } = await synReq(c);
    await ensureTailnetReady();
    return c.json(await synologyConnector(config).list(path, { cursor, limit }));
  });

  app.post("/synology/stat", async (c) => {
    const { config, path } = await synReq(c);
    await ensureTailnetReady();
    return c.json(await synologyConnector(config).stat(path));
  });

  app.post("/synology/read", async (c) => {
    const { config, path } = await synReq(c);
    await ensureTailnetReady();
    return c.body(await synologyConnector(config).read(path));
  });

  app.post("/synology/remove", async (c) => {
    const { config, path } = await synReq(c);
    await ensureTailnetReady();
    await synologyConnector(config).remove(path);
    return c.json({ ok: true });
  });

  app.post("/synology/mkdir", async (c) => {
    const { config, path } = await synReq(c);
    await ensureTailnetReady();
    await synologyConnector(config).mkdir?.(path);
    return c.json({ ok: true });
  });

  // Write carries raw bytes in the body, so config + path travel as headers.
  app.post("/synology/write", async (c) => {
    const config = JSON.parse(c.req.header("x-syn-config") || "{}") as SynologyConfig;
    const path = c.req.header("x-syn-path") || "";
    const bytes = await body(c);
    await ensureTailnetReady();
    return c.json(await synologyConnector(config).write(path, bytes));
  });

  return app;
}

/** Parse the JSON envelope shared by the connector-proxy routes. */
async function synReq(c: Context): Promise<{ config: SynologyConfig; path: string; cursor?: string; limit?: number }> {
  const b = (await c.req.json()) as { config: SynologyConfig; path?: string; cursor?: string; limit?: number };
  return { config: b.config, path: b.path ?? "", cursor: b.cursor, limit: b.limit };
}

/** Read the raw request body as bytes. */
async function body(c: Context): Promise<Uint8Array> {
  return new Uint8Array(await c.req.arrayBuffer());
}

/** File name + mime carried alongside an inline body. */
function docMeta(c: Context): { name: string; mime: string | null } {
  return { name: c.req.header("x-doc-name") || "file", mime: c.req.header("x-doc-mime") || null };
}

/** Parse a non-negative integer query param, or undefined. */
function intQuery(c: Context, key: string): number | undefined {
  const raw = c.req.query(key);
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
