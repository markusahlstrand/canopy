/// <reference types="node" />
import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { FlowGraph } from '@canopy/scope-drive/spec/model';
import type { DirectorySql } from '../src/space-creation';
import {
  FLOW_FAILURE_LIMIT, MAX_FLOWS, deleteFlow, flowsWatching, forgetScope, getFlow, importFlow, lastRun, listFlows, markRan, recordOutcome, saveFlow,
  type SaveFlow,
} from '../src/flow-directory';

function database() {
  const db = new DatabaseSync(':memory:');
  const sql: DirectorySql = {
    exec: (query, ...values) => {
      const stmt = db.prepare(query);
      return stmt.columns().length ? stmt.all(...values) as Record<string, unknown>[] : (stmt.run(...values), []);
    },
  };
  return { db, sql };
}

const graph: FlowGraph = {
  versions: 'first',
  nodes: [{ id: 't', type: 'trigger', on: 'arrived', spaces: ['bank'] }, { id: 'l', type: 'label', value: 'x' }],
  edges: [{ from: 't', to: 'l', branch: 'next' }],
};
const input = (over: Partial<SaveFlow> = {}): SaveFlow => ({
  id: 'f1', name: 'Statements', enabled: true, graph, author: 'Ada', authorSub: 'ada', now: '2026-11-15T00:00:00Z',
  scopes: { watch: ['s-bank'], write: ['s-a3'] }, ...over,
});

it('saves a flow with the spaces it touches, and finds it from the spaces it watches only', () => {
  const { db, sql } = database();
  expect(saveFlow(sql, input(), true)).toMatchObject({ id: 'f1', name: 'Statements', authorSub: 'ada', failures: 0 });
  expect(listFlows(sql)).toEqual([expect.objectContaining({ scopes: { watch: ['s-bank'], write: ['s-a3'] } })]);
  expect(flowsWatching(sql, 's-bank').map((f) => f.id)).toEqual(['f1']);
  expect(flowsWatching(sql, 's-a3')).toEqual([]);
  // Replacing moves its spaces, takes it on as the new author, and drops the old space's schedule mark.
  markRan(sql, 'f1', 's-bank', '2026-11-15T01:00:00Z');
  saveFlow(sql, input({ name: 'Renamed', authorSub: 'bob', scopes: { watch: ['s-other'], write: [] } }), false);
  expect(getFlow(sql, 'f1')).toMatchObject({ flow: { name: 'Renamed', authorSub: 'bob' }, scopes: { watch: ['s-other'], write: [] } });
  expect(flowsWatching(sql, 's-bank')).toEqual([]);
  expect(lastRun(sql, 'f1', 's-bank')).toBeNull();
  expect(saveFlow(sql, input({ id: 'missing' }), false)).toEqual({ error: 'not_found' });
  db.close();
});

it('pauses a flow after five failures in a row, and saving it starts it over', () => {
  const { db, sql } = database();
  saveFlow(sql, input(), true);
  recordOutcome(sql, 'f1', { ok: false, error: 'boom 1' });
  recordOutcome(sql, 'f1', { ok: true });
  expect(getFlow(sql, 'f1')!.flow.failures).toBe(0);
  for (let i = 0; i < FLOW_FAILURE_LIMIT; i++) recordOutcome(sql, 'f1', { ok: false, error: `boom ${i}` });
  expect(getFlow(sql, 'f1')!.flow).toMatchObject({ failures: FLOW_FAILURE_LIMIT, pausedReason: expect.stringContaining(`boom ${FLOW_FAILURE_LIMIT - 1}`) });
  saveFlow(sql, input(), false);
  expect(getFlow(sql, 'f1')!.flow).toMatchObject({ failures: 0, pausedReason: null });
  db.close();
});

it('keeps when a schedule last ran per space', () => {
  const { db, sql } = database();
  saveFlow(sql, input({ scopes: { watch: ['a', 'b'], write: [] } }), true);
  markRan(sql, 'f1', 'a', '2026-11-15T01:00:00Z');
  markRan(sql, 'f1', 'a', '2026-11-15T02:00:00Z');
  expect(lastRun(sql, 'f1', 'a')).toBe('2026-11-15T02:00:00Z');
  expect(lastRun(sql, 'f1', 'b')).toBeNull();
  db.close();
});

it('takes a flow from a space once, under its own id, with its record', () => {
  const { db, sql } = database();
  const carried = { ...input({ id: 'old' }), createdAt: '2026-11-01T00:00:00Z', failures: 2, pausedReason: null, lastRunAt: '2026-11-14T00:00:00Z' };
  expect(importFlow(sql, carried)).toBe(true);
  expect(importFlow(sql, { ...carried, name: 'Again' })).toBe(false);
  expect(getFlow(sql, 'old')!.flow).toMatchObject({ name: 'Statements', createdAt: '2026-11-01T00:00:00Z', failures: 2 });
  expect(lastRun(sql, 'old', 's-bank')).toBe('2026-11-14T00:00:00Z');
  db.close();
});

it('forgets a deleted space, deletes a flow, and holds a bounded number', () => {
  const { db, sql } = database();
  saveFlow(sql, input(), true);
  forgetScope(sql, 's-bank');
  expect(getFlow(sql, 'f1')!.scopes).toEqual({ watch: [], write: ['s-a3'] });
  deleteFlow(sql, 'f1');
  expect(listFlows(sql)).toEqual([]);
  for (let i = 0; i < MAX_FLOWS; i++) saveFlow(sql, input({ id: `f${i}` }), true);
  expect(saveFlow(sql, input({ id: 'one-more' }), true)).toEqual({ error: 'limit' });
  // A stored graph that no longer parses is never handed out.
  sql.exec("UPDATE canopy_flows SET graph_json = '{\"nodes\":\"broken\"}' WHERE id = 'f0'");
  expect(getFlow(sql, 'f0')).toBeNull();
  db.close();
});
