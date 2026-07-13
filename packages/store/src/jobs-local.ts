import type { Db } from "./db";
import { failRun, finishRun, startRun } from "./runs";
import { assertJobPayload, type JobContext, type JobRequest, type Jobs, type JobStepOpts } from "./jobs";

/** The workflow's `reconcile-*` retry policy — the rail-wide default. */
const DEFAULT_RETRIES = { limit: 3, delayMs: 5_000, backoff: "exponential" as const };

export interface LocalJobsDeps {
  db: Db;
  /** Registry lookup, composed in apps/api (T4). */
  handlers: (pluginId: string, name: string) => ((ctx: JobContext) => Promise<void>) | null;
  /** `RunLog`-shaped live-line sink (key = space id). Absent on hosts without a channel. */
  log?: (key: string, message: string, level?: "info" | "error") => Promise<void>;
  /** Injectable for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * In-process {@link Jobs} for Node / self-host (and the Cloudflare fallback when
 * the dispatcher Workflow isn't bound) — the generalization of
 * {@link inProcessIndexJobs}. Runs the handler to completion inside the returned
 * promise (the caller backgrounds it), recording a `runs` row around it:
 * running → done with the handler's cursor, or → error. `ctx.step` is sequential
 * execution with the same per-step retry/backoff the CF workflow uses; `ctx.log`
 * feeds the `RunLog` sink keyed by `logKey ?? instanceKey`.
 *
 * Coalescing: an in-memory keyed-promise map — the single-process reality on
 * Node. A `start` for an in-flight `pluginId:name:instanceKey` returns that
 * run's promise; a new run for the key is possible the moment it settles.
 */
export function inProcessJobs(deps: LocalJobsDeps): Jobs {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const inflight = new Map<string, Promise<void>>();

  async function execute(req: JobRequest, payload: Record<string, unknown>): Promise<void> {
    const run = await startRun(deps.db, { pluginId: req.pluginId, jobName: req.name, instanceKey: req.instanceKey });
    const logKey = req.logKey ?? req.instanceKey;
    const log = async (message: string, level?: "info" | "error") => {
      try {
        await deps.log?.(logKey, message, level);
      } catch {
        /* best-effort: a dropped progress line never fails a run */
      }
    };

    const handler = deps.handlers(req.pluginId, req.name);
    if (!handler) {
      // A runtime condition (stale schedule, uninstalled plugin), not a caller bug:
      // record it where the dashboard can see it instead of throwing into a
      // fire-and-forget caller.
      await failRun(deps.db, run.id, `no job handler registered for ${req.pluginId}:${req.name}`);
      return;
    }

    let nextCursor = run.cursor; // unset by the handler → carried forward
    const ctx: JobContext = {
      payload,
      cursor: run.cursor,
      setCursor: (next) => {
        nextCursor = next;
      },
      async step<T>(name: string, fn: () => Promise<T>, opts?: JobStepOpts): Promise<T> {
        const retries = opts?.retries ?? DEFAULT_RETRIES;
        let attempt = 0;
        // limit counts retries after the first attempt (CF semantics).
        for (;;) {
          try {
            return await fn();
          } catch (err) {
            attempt++;
            if (attempt > retries.limit) throw err;
            const factor = (retries.backoff ?? "exponential") === "exponential" ? 2 ** (attempt - 1) : 1;
            await sleep(retries.delayMs * factor);
          }
        }
      },
      log,
    };

    try {
      await handler(ctx);
      await finishRun(deps.db, run.id, { cursor: nextCursor });
    } catch (err) {
      await failRun(deps.db, run.id, (err as Error).message);
      throw err;
    }
  }

  return {
    start(req: JobRequest): Promise<void> {
      const key = `${req.pluginId}:${req.name}:${req.instanceKey}`;
      const existing = inflight.get(key);
      if (existing) return existing;
      // Validate + round-trip BEFORE anything runs: a payload that wouldn't
      // survive a real queue message is a caller bug and fails loudly, not a
      // run recorded as error.
      assertJobPayload(req.payload);
      const payload = JSON.parse(JSON.stringify(req.payload)) as Record<string, unknown>;
      const p = execute(req, payload).finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },
  };
}
