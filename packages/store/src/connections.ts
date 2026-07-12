import type { Db } from "./db";
import { failRun, finishRun, startRun } from "./runs";
import type { Connection } from "./types";

/**
 * A connected backend (a Synology NAS, a GitHub repo) the user owns, whose objects
 * are indexed into the file table. One row per (owner, plugin); its id doubles as
 * the connected space's id (`connector:<plugin>:<sub>`). `config` holds only
 * non-secret display state — real secrets stay encrypted in `plugin_settings`.
 * The row exists so an {@link IndexRun} crawl can checkpoint against it.
 */

interface ConnectionRow {
  id: string;
  tenant_id: string;
  owner_id: string;
  type: string;
  name: string;
  config: string;
  created_at: string;
}

const toConnection = (r: ConnectionRow): Connection => {
  let config: Record<string, unknown> = {};
  try {
    const v = JSON.parse(r.config);
    if (v && typeof v === "object") config = v as Record<string, unknown>;
  } catch {
    /* keep {} */
  }
  return { id: r.id, tenantId: r.tenant_id, ownerId: r.owner_id, type: r.type, name: r.name, config, createdAt: r.created_at };
};

/** Ensure a connection row exists (idempotent). */
export async function ensureConnection(
  db: Db,
  input: { id: string; tenantId: string; ownerId: string; type: string; name: string },
): Promise<void> {
  await db.run(
    `INSERT OR IGNORE INTO connections (id, tenant_id, owner_id, type, name, config, created_at)
     VALUES (?, ?, ?, ?, ?, '{}', ?)`,
    [input.id, input.tenantId, input.ownerId, input.type, input.name, new Date().toISOString()],
  );
}

export async function getConnection(db: Db, id: string): Promise<Connection | null> {
  const row = await db.first<ConnectionRow>("SELECT * FROM connections WHERE id = ?", [id]);
  return row ? toConnection(row) : null;
}

/** All connections of a given type (e.g. every user's "synology") — for the sweep. */
export async function listConnectionsByType(db: Db, type: string): Promise<Connection[]> {
  const rows = await db.all<ConnectionRow>("SELECT * FROM connections WHERE type = ? ORDER BY created_at", [type]);
  return rows.map(toConnection);
}

/** Every connection, regardless of type — for an all-backends sweep. */
export async function listAllConnections(db: Db): Promise<Connection[]> {
  const rows = await db.all<ConnectionRow>("SELECT * FROM connections ORDER BY created_at", []);
  return rows.map(toConnection);
}

// ── index runs (resumable crawl bookkeeping) ─────────────────────────────────
// Each sweep of a connection is a `runs` row (jobs rail, T1) keyed
// (connection type, 'connector-index', connection id). The `cursor` carries the
// high-water change marker (for Synology: the last seen mtime, unix seconds) from
// the most recent successful run to the next, so an incremental sweep only revisits
// what changed since. These three are thin compatibility wrappers over runs.ts so
// existing callers compile unchanged; they go away when connector indexing moves
// onto the generic rail (T6).

/** Start a sweep: record a 'running' run seeded with the last successful cursor. Returns the run id + that cursor. */
export async function startIndexRun(db: Db, connectionId: string): Promise<{ id: string; cursor: string | null }> {
  // plugin_id = the connection's type; '' when the row is gone, matching how the
  // migration copied orphaned index_runs rows, so their cursor still resolves.
  const conn = await getConnection(db, connectionId);
  return startRun(db, { pluginId: conn?.type ?? "", jobName: "connector-index", instanceKey: connectionId });
}

/** Mark a run done, persisting its new cursor + count. */
export async function finishIndexRun(db: Db, runId: string, out: { cursor: string | null; filesSeen: number }): Promise<void> {
  await finishRun(db, runId, { cursor: out.cursor, stats: { filesSeen: out.filesSeen } });
}

/** Mark a run failed (its cursor is not advanced, so the next run retries the same range). */
export async function failIndexRun(db: Db, runId: string, error: string): Promise<void> {
  await failRun(db, runId, error);
}
