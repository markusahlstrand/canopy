/**
 * Background-work port for the jobs rail (T2) — the generalization of
 * {@link IndexJobs} from one hard-coded crawl to named handlers. Same
 * declaration style: structural + serializable, zero Cloudflare / `@canopy/core`
 * types, selected once at composition time like `DocWorker`. On Cloudflare the
 * adapter is a generic dispatcher Workflow (T3); on Node / self-host it's the
 * in-process loop in {@link inProcessJobs} (jobs-local.ts). Handler *types* the
 * plugin side sees (`JobDefinition`, the `jobs` role) live in
 * `@canopy/core/plugin-roles` (T4) — structurally compatible, joined in apps/api.
 */

/**
 * One job dispatch. `payload` carries ids/config only, NEVER bytes — the
 * queue-message rule from {@link ExtractJob}: a run fetches bytes itself inside
 * a step. Adapters JSON-round-trip the payload and reject non-plain values
 * loudly ({@link assertJobPayload}), so a payload that wouldn't survive a real
 * queue never appears to work in-process.
 */
export interface JobRequest {
  pluginId: string;
  name: string;
  /** What this run is "about" (a space id, a flow id, …) — the coalescing key's last part. */
  instanceKey: string;
  payload: Record<string, unknown>;
  /**
   * Live-log channel key (a space id — see `RunLog`), when it differs from
   * `instanceKey`. Connector indexing omits it (its instanceKey IS the space id);
   * a sync flow passes its target space so progress lines reach that channel.
   */
  logKey?: string;
}

/**
 * The dispatch port. `start` is idempotent per `pluginId:name:instanceKey`
 * while a run for that key is in flight — the coalescing contract, enforced by
 * the adapter (keyed promises in-process, deterministic Workflow instance ids
 * on CF), never by the `runs` table. Resolution timing is adapter-specific
 * (in-process: the run itself; CF: dispatch accepted) — callers background it
 * (`waitUntil` / fire-and-forget) and must not read completion from it.
 */
export interface Jobs {
  start(req: JobRequest): Promise<void>;
}

/**
 * Per-step retry policy, structurally mirroring a CF Workflow's `step.do`
 * config so the T3 adapter maps it 1:1. `limit` counts retries AFTER the first
 * attempt (limit 3 → up to 4 attempts). Defaults match the existing workflow's
 * `reconcile-*` steps: 3 retries, 5s delay, exponential backoff.
 */
export interface JobStepOpts {
  retries?: { limit: number; delayMs: number; backoff?: "constant" | "exponential" };
}

/**
 * What a handler runs against. `step` is the durability seam: on CF each step
 * is one `step.do` (own budget, cached on replay), in-process it's sequential
 * execution with the same retry policy. DETERMINISM CONTRACT: step names must
 * be a pure function of the payload + prior step results (the `reconcile-<n>`
 * pattern) — never of wall-clock, randomness, or out-of-band state — so a
 * crash-resume replays the same name sequence. Step results must be
 * JSON-serializable (they're the replay cache on CF).
 */
export interface JobContext {
  payload: Record<string, unknown>;
  /** The last successful run's cursor for this key (high-water mark), or null. */
  cursor: string | null;
  /**
   * Set the cursor the run persists on success. Unset, the previous cursor is
   * carried forward; a failed run never advances it (runs.ts contract).
   */
  setCursor(next: string | null): void;
  step<T>(name: string, fn: () => Promise<T>, opts?: JobStepOpts): Promise<T>;
  /** One live progress line to the run's channel (best-effort, never persisted). */
  log(message: string, level?: "info" | "error"): Promise<void>;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

/**
 * Registry lookup the adapters take as a dependency. The registry itself is
 * composed in apps/api from the `jobs` server-plugin role (T4) — the store
 * never knows what's registered.
 */
export type JobHandlers = (pluginId: string, name: string) => JobHandler | null;

/**
 * Reject a payload that wouldn't survive a queue message: only JSON scalars,
 * plain objects, and arrays. Raw bytes (TypedArray/ArrayBuffer), functions,
 * class instances (Date, Map, …), bigints, symbols, undefined, and non-finite
 * numbers all throw with the offending path — ids, never bytes.
 */
export function assertJobPayload(value: unknown, path = "payload"): void {
  if (value === null) return;
  const t = typeof value;
  if (t === "string" || t === "boolean") return;
  if (t === "number") {
    if (!Number.isFinite(value as number)) throw new Error(`${path} is not JSON-serializable (non-finite number)`);
    return;
  }
  if (t !== "object") throw new Error(`${path} is not JSON-serializable (${t})`);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new Error(`${path} contains raw bytes — job payloads carry ids/config only, never bytes`);
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertJobPayload(v, `${path}[${i}]`));
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`${path} is not a plain JSON object (got ${value?.constructor?.name ?? "unknown"})`);
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) assertJobPayload(v, `${path}.${k}`);
}
