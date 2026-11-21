import { describe, expect, it } from 'vitest';
import { flowSaveInput } from '../../src/flow-contract';
import { draftJson, readDraft } from './flow-raw';
import type { Draft } from './flow-editor';

const draft: Draft = {
  id: 'f1', name: 'Statements', enabled: true,
  graph: {
    nodes: [
      { id: 'trigger', type: 'trigger', on: 'arrived', spaces: ['bank'], position: { x: 0, y: 0 } },
      { id: 'label-1', type: 'label', value: 'review', position: { x: 300, y: 0 } },
    ],
    edges: [{ from: 'trigger', to: 'label-1', branch: 'next' }],
    versions: 'first',
  },
};
const edit = (change: (value: Record<string, unknown>) => void) => {
  const value = JSON.parse(draftJson(draft)) as Record<string, unknown>;
  change(value);
  return JSON.stringify(value);
};

describe('a flow as JSON', () => {
  it('holds what a person edits, never the id', () => {
    const value = JSON.parse(draftJson(draft)) as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(['name', 'enabled', 'graph']);
    expect(draftJson(draft)).toContain('\n  "name": "Statements"');
  });

  it('reads back to the same draft, keeping the flow’s own id', () => {
    expect(readDraft(draftJson(draft), 'f1', 'save')).toEqual({ ok: true, draft, ignored: [] });
    const fresh = readDraft(draftJson(draft), undefined, 'save');
    expect(fresh.ok && 'id' in fresh.draft).toBe(false);
  });

  it('refuses text that is not JSON, or not a flow object', () => {
    const broken = readDraft('{ "name": "x", ', 'f1', 'save');
    expect(broken.ok).toBe(false);
    expect(!broken.ok && broken.problems[0]).toMatch(/^This isn’t valid JSON: /);
    expect(readDraft('[1, 2]', 'f1', 'save')).toEqual({ ok: false, problems: ['A flow is a JSON object with a name, enabled and a graph.'] });
    expect(readDraft('null', 'f1', 'save').ok).toBe(false);
  });

  it('ignores the fields the server keeps, and never takes another id', () => {
    const text = edit((v) => Object.assign(v, { id: 'someone-elses', author: 'Eve', createdAt: '2020-01-01', failures: 99 }));
    const read = readDraft(text, 'f1', 'save');
    expect(read).toEqual({ ok: true, draft, ignored: ['id', 'author', 'createdAt', 'failures'] });
  });

  it('refuses what the save route refuses, with where and why', () => {
    const noName = readDraft(edit((v) => { v.name = '   '; }), 'f1', 'save');
    expect(noName.ok).toBe(false);
    expect(!noName.ok && noName.problems[0]).toMatch(/^name: /);

    const noAction = edit((v) => {
      const graph = v.graph as Draft['graph'];
      graph.nodes = graph.nodes.filter((n) => n.type === 'trigger');
      graph.edges = [];
    });
    const read = readDraft(noAction, 'f1', 'save');
    expect(read.ok).toBe(false);
    expect(!read.ok && read.problems).toContain('graph: A flow needs at least one action: copy or label.');
    expect(!read.ok && read.problems).toContain('graph › nodes › trigger: Connect the trigger to the first step.');

    const badNode = edit((v) => { (v.graph as { nodes: unknown[] }).nodes.push({ id: 'x', type: 'teleport' }); });
    expect(readDraft(badNode, 'f1', 'save').ok).toBe(false);

    // The very schema the route checks with: the two agree on every one of these.
    for (const text of [draftJson(draft), noAction, badNode, edit((v) => { v.enabled = 'yes'; })]) {
      const { name, enabled, graph } = JSON.parse(text) as Record<string, unknown>;
      expect(readDraft(text, 'f1', 'save').ok).toBe(flowSaveInput.safeParse({ name, enabled, graph }).success);
    }
  });

  it('lets the canvas take a flow that is still being drawn, but not one it cannot draw', () => {
    const unfinished = edit((v) => {
      v.name = '';
      const graph = v.graph as Draft['graph'];
      graph.nodes = graph.nodes.filter((n) => n.type === 'trigger');
      graph.edges = [];
    });
    expect(readDraft(unfinished, 'f1', 'save').ok).toBe(false);
    const read = readDraft(unfinished, 'f1', 'canvas');
    expect(read.ok && read.draft.name).toBe('');

    const badNode = edit((v) => { (v.graph as { nodes: unknown[] }).nodes.push({ id: 'x', type: 'teleport' }); });
    expect(readDraft(badNode, 'f1', 'canvas').ok).toBe(false);
  });
});
