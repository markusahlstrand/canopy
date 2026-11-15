/**
 * Flows, kept by the install: in the tenant's identity DO, beside the space list and each space's
 * settings, because a flow may watch several spaces and copy into others, so no one space owns it.
 *
 * Each flow names the spaces it touches by scope id (`canopy_flow_spaces`), read off its graph when
 * it is saved: the dispatcher of a space finds the flows that watch it with one indexed lookup, and
 * the routes decide who sees a flow (whoever owns every one of its spaces) without parsing graphs.
 * A schedule runs per space, so when it last ran is kept per space too.
 *
 * What a flow DID stays in the space of the document it did it to (`drive_flow_deliveries`).
 */
import { flowGraphShape, type FlowGraph, type StoredFlow } from '@canopy/scope-drive/spec/model';
import type { DirectorySql } from './space-creation';

/** After this many failures in a row a flow stops itself, and says why. */
export const FLOW_FAILURE_LIMIT = 5;
/** An install holds at most this many flows. */
export const MAX_FLOWS = 100;

/** A flow as the runner reads it: with the login it acts as. */
export interface DirectoryFlow extends StoredFlow { authorSub: string }

/** The spaces a flow touches, by scope id. */
export interface FlowScopes { watch: string[]; write: string[] }

const ensure = (sql: DirectorySql) => {
  sql.exec(`CREATE TABLE IF NOT EXISTS canopy_flows (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL, graph_json TEXT NOT NULL,
    author TEXT NOT NULL, author_sub TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0, paused_reason TEXT)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS canopy_flow_spaces (
    flow_id TEXT NOT NULL, scope_id TEXT NOT NULL, watch INTEGER NOT NULL, write INTEGER NOT NULL,
    PRIMARY KEY (flow_id, scope_id))`);
  sql.exec('CREATE INDEX IF NOT EXISTS canopy_flow_spaces_scope ON canopy_flow_spaces (scope_id, watch)');
  sql.exec(`CREATE TABLE IF NOT EXISTS canopy_flow_runs (
    flow_id TEXT NOT NULL, scope_id TEXT NOT NULL, last_run_at TEXT NOT NULL, PRIMARY KEY (flow_id, scope_id))`);
};

type Row = {
  id: string; name: string; enabled: number; graph_json: string; author: string; author_sub: string;
  created_at: string; updated_at: string; failures: number; paused_reason: string | null;
};

/** A stored flow, or null when its graph no longer parses (an older shape): never run, never shown as runnable. */
function flowFrom(row: Row): DirectoryFlow | null {
  let raw: unknown;
  try { raw = JSON.parse(row.graph_json); } catch { return null; }
  const graph = flowGraphShape.safeParse(raw);
  if (!graph.success) return null;
  return {
    id: row.id, name: row.name, enabled: row.enabled === 1, graph: graph.data, author: row.author, authorSub: row.author_sub,
    createdAt: row.created_at, updatedAt: row.updated_at, failures: row.failures, pausedReason: row.paused_reason,
  };
}

const rows = <T>(sql: DirectorySql, query: string, ...values: (string | number | null)[]) => [...sql.exec(query, ...values)] as T[];
const parsed = (list: Row[]) => list.map(flowFrom).filter((f): f is DirectoryFlow => f !== null);

/** Every flow, with the spaces it touches. */
export function listFlows(sql: DirectorySql): { flow: DirectoryFlow; scopes: FlowScopes }[] {
  ensure(sql);
  const touched = new Map<string, FlowScopes>();
  for (const r of rows<{ flow_id: string; scope_id: string; watch: number; write: number }>(sql, 'SELECT * FROM canopy_flow_spaces ORDER BY scope_id')) {
    const scopes = touched.get(r.flow_id) ?? { watch: [], write: [] };
    if (r.watch) scopes.watch.push(r.scope_id);
    if (r.write) scopes.write.push(r.scope_id);
    touched.set(r.flow_id, scopes);
  }
  return parsed(rows<Row>(sql, 'SELECT * FROM canopy_flows ORDER BY created_at, id'))
    .map((flow) => ({ flow, scopes: touched.get(flow.id) ?? { watch: [], write: [] } }));
}

export function getFlow(sql: DirectorySql, id: string): { flow: DirectoryFlow; scopes: FlowScopes } | null {
  return listFlows(sql).find((f) => f.flow.id === id) ?? null;
}

/** The flows that watch a space: what its dispatcher offers each arrival to. */
export function flowsWatching(sql: DirectorySql, scope: string): DirectoryFlow[] {
  ensure(sql);
  return parsed(rows<Row>(sql, `SELECT f.* FROM canopy_flows f JOIN canopy_flow_spaces s ON s.flow_id = f.id
    WHERE s.scope_id = ? AND s.watch = 1 ORDER BY f.created_at, f.id`, scope));
}

function setScopes(sql: DirectorySql, id: string, scopes: FlowScopes) {
  sql.exec('DELETE FROM canopy_flow_spaces WHERE flow_id = ?', id);
  for (const scope of new Set([...scopes.watch, ...scopes.write])) {
    sql.exec('INSERT INTO canopy_flow_spaces (flow_id, scope_id, watch, write) VALUES (?, ?, ?, ?)',
      id, scope, scopes.watch.includes(scope) ? 1 : 0, scopes.write.includes(scope) ? 1 : 0);
  }
}

export interface SaveFlow {
  id: string; name: string; enabled: boolean; graph: FlowGraph; author: string; authorSub: string; scopes: FlowScopes; now: string;
}

/**
 * Create (`create`) or replace a flow. Saving is taking it on: the flow acts as whoever saved it
 * last, and starts over unpaused.
 */
export function saveFlow(sql: DirectorySql, input: SaveFlow, create: boolean): DirectoryFlow | { error: 'limit' | 'not_found' } {
  ensure(sql);
  const graph = JSON.stringify(input.graph);
  const exists = rows(sql, 'SELECT 1 FROM canopy_flows WHERE id = ?', input.id).length > 0;
  if (!create && !exists) return { error: 'not_found' };
  if (exists) {
    sql.exec(`UPDATE canopy_flows SET name = ?, enabled = ?, graph_json = ?, author = ?, author_sub = ?, updated_at = ?,
      failures = 0, paused_reason = NULL WHERE id = ?`, input.name, input.enabled ? 1 : 0, graph, input.author, input.authorSub, input.now, input.id);
  } else {
    const [count] = rows<{ n: number }>(sql, 'SELECT COUNT(*) AS n FROM canopy_flows');
    if ((count?.n ?? 0) >= MAX_FLOWS) return { error: 'limit' };
    sql.exec(`INSERT INTO canopy_flows (id, name, enabled, graph_json, author, author_sub, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, input.id, input.name, input.enabled ? 1 : 0, graph, input.author, input.authorSub, input.now, input.now);
  }
  setScopes(sql, input.id, input.scopes);
  // A space no longer watched keeps no schedule mark; one watched again starts afresh.
  for (const r of rows<{ scope_id: string }>(sql, 'SELECT scope_id FROM canopy_flow_runs WHERE flow_id = ?', input.id)) {
    if (!input.scopes.watch.includes(r.scope_id)) sql.exec('DELETE FROM canopy_flow_runs WHERE flow_id = ? AND scope_id = ?', input.id, r.scope_id);
  }
  return getFlow(sql, input.id)!.flow;
}

/**
 * A flow carried over from a space that kept its own, under its own id so its history in that
 * space still belongs to it. Once only: a flow already here is left as it is.
 */
export function importFlow(sql: DirectorySql, input: SaveFlow & { createdAt: string; failures: number; pausedReason: string | null; lastRunAt: string | null }): boolean {
  ensure(sql);
  if (rows(sql, 'SELECT 1 FROM canopy_flows WHERE id = ?', input.id).length) return false;
  sql.exec(`INSERT INTO canopy_flows (id, name, enabled, graph_json, author, author_sub, created_at, updated_at, failures, paused_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, input.id, input.name, input.enabled ? 1 : 0, JSON.stringify(input.graph), input.author,
  input.authorSub, input.createdAt, input.now, input.failures, input.pausedReason);
  setScopes(sql, input.id, input.scopes);
  for (const scope of input.scopes.watch) if (input.lastRunAt) markRan(sql, input.id, scope, input.lastRunAt);
  return true;
}

export function deleteFlow(sql: DirectorySql, id: string): void {
  ensure(sql);
  sql.exec('DELETE FROM canopy_flow_runs WHERE flow_id = ?', id);
  sql.exec('DELETE FROM canopy_flow_spaces WHERE flow_id = ?', id);
  sql.exec('DELETE FROM canopy_flows WHERE id = ?', id);
}

export function setEnabled(sql: DirectorySql, id: string, enabled: boolean): void {
  ensure(sql);
  sql.exec('UPDATE canopy_flows SET enabled = ? WHERE id = ?', enabled ? 1 : 0, id);
}

/** A run finished: a success clears the count of failures, the fifth failure in a row pauses the flow. */
export function recordOutcome(sql: DirectorySql, id: string, outcome: { ok: true } | { ok: false; error: string }): void {
  ensure(sql);
  if (outcome.ok) { sql.exec('UPDATE canopy_flows SET failures = 0 WHERE id = ?', id); return; }
  const [row] = rows<{ failures: number }>(sql, 'SELECT failures FROM canopy_flows WHERE id = ?', id);
  if (!row) return;
  const failures = row.failures + 1;
  const paused = failures >= FLOW_FAILURE_LIMIT ? `Paused after ${failures} failures in a row. Last: ${outcome.error.slice(0, 300)}` : null;
  sql.exec('UPDATE canopy_flows SET failures = ?, paused_reason = COALESCE(paused_reason, ?) WHERE id = ?', failures, paused, id);
}

/** When a scheduled flow last ran in a space, or null when it never has. */
export function lastRun(sql: DirectorySql, id: string, scope: string): string | null {
  ensure(sql);
  return rows<{ last_run_at: string }>(sql, 'SELECT last_run_at FROM canopy_flow_runs WHERE flow_id = ? AND scope_id = ?', id, scope)[0]?.last_run_at ?? null;
}

export function markRan(sql: DirectorySql, id: string, scope: string, at: string): void {
  ensure(sql);
  sql.exec(`INSERT INTO canopy_flow_runs (flow_id, scope_id, last_run_at) VALUES (?, ?, ?)
    ON CONFLICT(flow_id, scope_id) DO UPDATE SET last_run_at = excluded.last_run_at`, id, scope, at);
}

/** Forget a space: flows that only it held go, and it leaves the others' lists (they stop reacting there). */
export function forgetScope(sql: DirectorySql, scope: string): void {
  ensure(sql);
  sql.exec('DELETE FROM canopy_flow_spaces WHERE scope_id = ?', scope);
  sql.exec('DELETE FROM canopy_flow_runs WHERE scope_id = ?', scope);
}
