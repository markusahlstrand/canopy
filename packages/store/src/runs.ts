import type { Db } from "./db";

/**
 * Background-job run bookkeeping (jobs rail, T1) — the generalization of the old
 * `index_runs` table. Every job on the rail needs the same triple: a status row,
 * a resume cursor handed from the last successful run to the next, and a JSON
 * counter bag. A run is keyed by (pluginId, jobName, instanceKey) — for the
 * connector crawl that's (connection type, 'connector-index', connection id).
 *
 * Concurrency is deliberately NOT enforced here: two concurrent `startRun` calls
 * for one key produce two rows. Coalescing ("one in-flight run per key") is the
 * dispatcher's contract (T2/T3) — a table-level constraint would block
 * legitimate re-runs after a crash.
 */

export type RunStatus = "queued" | "running" | "done" | "error";

/** What identifies a job's run history: which handler, for which instance. */
export interface RunKey {
  pluginId: string;
  jobName: string;
  instanceKey: string;
}

export interface Run {
  id: string;
  pluginId: string;
  jobName: string;
  instanceKey: string;
  status: RunStatus;
  cursor: string | null;
  /** JSON counter bag, e.g. `{ filesSeen: 42 }`. Shape is the job's own. */
  stats: Record<string, unknown>;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

interface RunRow {
  id: string;
  plugin_id: string;
  job_name: string;
  instance_key: string;
  status: RunStatus;
  cursor: string | null;
  stats: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

const toRun = (r: RunRow): Run => {
  let stats: Record<string, unknown> = {};
  try {
    const v = JSON.parse(r.stats);
    if (v && typeof v === "object") stats = v as Record<string, unknown>;
  } catch {
    /* keep {} */
  }
  return {
    id: r.id,
    pluginId: r.plugin_id,
    jobName: r.job_name,
    instanceKey: r.instance_key,
    status: r.status,
    cursor: r.cursor,
    stats,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    error: r.error,
  };
};

/**
 * Start a run: record a 'running' row seeded with the key's last *successful*
 * cursor (a failed run never advances the cursor, so the next run retries the
 * same range). Returns the run id + that cursor.
 */
export async function startRun(db: Db, key: RunKey): Promise<{ id: string; cursor: string | null }> {
  const last = await db.first<{ cursor: string | null }>(
    `SELECT cursor FROM runs
      WHERE plugin_id = ? AND job_name = ? AND instance_key = ? AND status = 'done'
      ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
    [key.pluginId, key.jobName, key.instanceKey],
  );
  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO runs (id, plugin_id, job_name, instance_key, status, cursor, stats, started_at)
     VALUES (?, ?, ?, ?, 'running', ?, '{}', ?)`,
    [id, key.pluginId, key.jobName, key.instanceKey, last?.cursor ?? null, new Date().toISOString()],
  );
  return { id, cursor: last?.cursor ?? null };
}

/** Mark a run done, persisting its new cursor + stats. */
export async function finishRun(
  db: Db,
  runId: string,
  out: { cursor: string | null; stats?: Record<string, unknown> },
): Promise<void> {
  await db.run("UPDATE runs SET status = 'done', cursor = ?, stats = ?, finished_at = ? WHERE id = ?", [
    out.cursor,
    JSON.stringify(out.stats ?? {}),
    new Date().toISOString(),
    runId,
  ]);
}

/** Mark a run failed. Its cursor is not advanced, so the next run retries the same range. */
export async function failRun(db: Db, runId: string, error: string): Promise<void> {
  await db.run("UPDATE runs SET status = 'error', error = ?, finished_at = ? WHERE id = ?", [
    String(error ?? "").slice(0, 500),
    new Date().toISOString(),
    runId,
  ]);
}

/** The most recent run for a key (any status), or null. */
export async function latestRun(db: Db, key: RunKey): Promise<Run | null> {
  const row = await db.first<RunRow>(
    `SELECT * FROM runs WHERE plugin_id = ? AND job_name = ? AND instance_key = ?
      ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    [key.pluginId, key.jobName, key.instanceKey],
  );
  return row ? toRun(row) : null;
}

/** Run history, newest first. Every filter is optional; `limit` defaults to 50. */
export async function listRuns(
  db: Db,
  filter: { pluginId?: string; jobName?: string; instanceKey?: string; status?: RunStatus; limit?: number } = {},
): Promise<Run[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.pluginId !== undefined) {
    where.push("plugin_id = ?");
    params.push(filter.pluginId);
  }
  if (filter.jobName !== undefined) {
    where.push("job_name = ?");
    params.push(filter.jobName);
  }
  if (filter.instanceKey !== undefined) {
    where.push("instance_key = ?");
    params.push(filter.instanceKey);
  }
  if (filter.status !== undefined) {
    where.push("status = ?");
    params.push(filter.status);
  }
  params.push(Math.max(1, Math.min(filter.limit ?? 50, 500)));
  const rows = await db.all<RunRow>(
    `SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC, rowid DESC LIMIT ?`,
    params,
  );
  return rows.map(toRun);
}
