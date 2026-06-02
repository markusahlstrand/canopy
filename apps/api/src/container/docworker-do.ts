// Durable Object that manages the document-parser container (Cloudflare-only).
//
// ISOLATION: this is the single file that depends on `@cloudflare/containers`
// (and, transitively, Cloudflare runtime types via `cloudflare:workers`). It is
// reached only through `worker-cf.ts`, and both are EXCLUDED from `apps/api`'s
// main `tsc` typecheck (which stays on lib DOM + structural binding types, no
// `@cloudflare/workers-types`). Wrangler/esbuild transpiles it at deploy. The
// Node deployment never imports this file.
//
// The base `Container` class handles the container lifecycle and forwards the
// DO's `fetch()` to the container's `defaultPort`; the Worker reaches it via the
// raw DO binding (see `containerDocWorker` in `extract-container.ts`).
import { Container } from "@cloudflare/containers";

/** Secrets/vars passed through to the container as env (set via `wrangler secret put`). */
type DocWorkerEnv = {
  DOCWORKER_TOKEN?: string;
  TS_AUTHKEY?: string;
  TS_HOSTNAME?: string;
};

export class DocWorker extends Container<DocWorkerEnv> {
  defaultPort = 8080;
  // Keep one instance warm-ish; the parser is only hit on demand. Tune for cost.
  sleepAfter = "15m";

  constructor(ctx: DurableObjectState, env: DocWorkerEnv) {
    super(ctx, env);
    // Baseline env. TS_AUTHKEY here (from a Worker secret) is only an optional
    // single-tenant fallback; the real per-tenant key arrives per request below.
    this.envVars = {
      ...(env.DOCWORKER_TOKEN ? { DOCWORKER_TOKEN: env.DOCWORKER_TOKEN } : {}),
      ...(env.TS_AUTHKEY ? { TS_AUTHKEY: env.TS_AUTHKEY } : {}),
      ...(env.TS_HOSTNAME ? { TS_HOSTNAME: env.TS_HOSTNAME } : {}),
      TAILNET_PROXY_URL: "http://127.0.0.1:1055",
    };
  }

  // PER-TENANT TAILNET: each instance is keyed (by the Worker) to one tailnet
  // identity, so the auth key that arrives on the first request is THIS user's.
  // We set it into the container's start env before the base auto-starts the
  // container, so the tsnet sidecar joins the right tailnet. (If a future
  // @cloudflare/containers requires explicit start to pick up env, switch this to
  // `await this.startAndWaitForPorts({ envVars: this.envVars })` before forwarding.)
  override async fetch(request: Request): Promise<Response> {
    const authKey = request.headers.get("x-ts-authkey");
    if (authKey) this.envVars = { ...this.envVars, TS_AUTHKEY: authKey };
    return super.fetch(request);
  }
}
