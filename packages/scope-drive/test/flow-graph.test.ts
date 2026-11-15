import { describe, expect, it } from 'vitest';
import {
  flowGraph, graphMatches, graphProblems, legacyToGraph, legacyFlowDefinition, reach, reactsTo, scheduleDue, spacesOf, walk,
  type FileFacts, type FlowGraph,
} from '../spec/model.js';

const facts = (over: Partial<FileFacts> = {}): FileFacts => ({ name: 'Statement.pdf', folderPath: 'Bank', labels: [], category: null, ...over });

/** Statements to the accountant at once; anything else in Bank waits for approval, then gets a label. */
const branching: FlowGraph = {
  versions: 'first',
  nodes: [
    { id: 't', type: 'trigger', on: 'arrived', spaces: ['bank', 'receipts'] },
    { id: 'pdf', type: 'check', condition: { field: 'extension', values: ['pdf'] } },
    { id: 'statement', type: 'check', condition: { field: 'name', op: 'contains', value: 'statement' } },
    { id: 'copy', type: 'copy', space: 'gestoria', folderId: 'f1', alsoIn: [] },
    { id: 'wait', type: 'approval' },
    { id: 'label', type: 'label', value: 'review' },
  ],
  edges: [
    { from: 't', to: 'pdf', branch: 'next' },
    { from: 'pdf', to: 'statement', branch: 'yes' },
    { from: 'statement', to: 'copy', branch: 'yes' },
    { from: 'statement', to: 'wait', branch: 'no' },
    { from: 'wait', to: 'label', branch: 'next' },
  ],
};

const messages = (graph: Pick<FlowGraph, 'nodes' | 'edges'>) => graphProblems(graph).map((p) => p.message);

describe('the rules a graph must keep', () => {
  it('accepts a branching flow', () => {
    expect(graphProblems(branching)).toEqual([]);
    expect(flowGraph.safeParse(branching).success).toBe(true);
  });

  it('needs one trigger, connected, and an action', () => {
    expect(messages({ nodes: [{ id: 'l', type: 'label', value: 'x' }], edges: [] })).toContain('A flow needs a trigger: what starts it.');
    expect(messages({ nodes: [{ id: 't', type: 'trigger', on: 'arrived', spaces: ['a'] }], edges: [] }))
      .toEqual(expect.arrayContaining(['A flow needs at least one action: copy or label.', 'Connect the trigger to the first step.']));
    const twoTriggers = { ...branching, nodes: [...branching.nodes, { id: 't2', type: 'trigger' as const, on: 'arrived' as const, spaces: ['a'] }] };
    expect(messages(twoTriggers)).toContain('A flow starts at one trigger.');
  });

  it('gives a check Yes and No, and everything else one next step', () => {
    expect(messages({ ...branching, edges: [...branching.edges, { from: 'pdf', to: 'label', branch: 'next' }] })).toContain('A check leads on by Yes or No.');
    expect(messages({ ...branching, edges: [...branching.edges, { from: 'copy', to: 'label', branch: 'yes' }] })).toContain('Only a check has Yes and No exits.');
    expect(messages({ ...branching, edges: [...branching.edges, { from: 'statement', to: 'label', branch: 'yes' }] })).toContain('A check has one Yes exit.');
    expect(messages({ ...branching, edges: [...branching.edges, { from: 'copy', to: 'label', branch: 'next' }, { from: 'copy', to: 'wait', branch: 'next' }] }))
      .toContain('A step leads to one next step.');
  });

  it('refuses loops, loose steps, two waits on a path, and a wait that leads nowhere', () => {
    expect(messages({ ...branching, edges: [...branching.edges, { from: 'label', to: 'pdf', branch: 'next' }] })).toContain('The flow loops back on itself. Each path has to end.');
    expect(graphProblems({ ...branching, nodes: [...branching.nodes, { id: 'loose', type: 'label', value: 'x' }] }))
      .toContainEqual({ message: 'This step is not connected to the trigger.', node: 'loose' });
    const twoWaits: FlowGraph = {
      ...branching,
      nodes: [...branching.nodes, { id: 'wait2', type: 'approval' }],
      edges: [...branching.edges.filter((e) => e.from !== 'wait'), { from: 'wait', to: 'wait2', branch: 'next' }, { from: 'wait2', to: 'label', branch: 'next' }],
    };
    expect(messages(twoWaits)).toContain('A path waits for approval once at most.');
    expect(graphProblems({ ...branching, edges: branching.edges.filter((e) => e.from !== 'wait') }))
      .toContainEqual(expect.objectContaining({ message: 'Connect what happens once you approve.', node: 'wait' }));
  });

  it('asks a schedule how often, and nothing else', () => {
    const t = (over: object) => ({ ...branching, nodes: branching.nodes.map((n) => (n.type === 'trigger' ? { ...n, ...over } : n)) });
    expect(messages(t({ on: 'schedule' }))).toContain('Say how often the schedule runs.');
    expect(messages(t({ on: 'arrived', every: 'day' }))).toContain('Only a schedule runs every hour, day, week or month.');
    expect(graphProblems(t({ on: 'schedule', every: 'day' }))).toEqual([]);
  });

  it('reads the spaces it touches off the graph', () => {
    expect(spacesOf(branching)).toEqual({ watch: ['bank', 'receipts'], write: ['gestoria'] });
    expect(reactsTo(branching, 'arrived', 'receipts')).toBe(true);
    expect(reactsTo(branching, 'arrived', 'gestoria')).toBe(false);
    expect(reactsTo(branching, 'classified', 'bank')).toBe(false);
  });
});

describe('one document through a flow', () => {
  it('takes the Yes branch, the No branch, or ends where a check has no exit', () => {
    expect(walk(branching, facts()).path).toEqual(['t', 'pdf', 'statement', 'copy']);
    expect(walk(branching, facts({ name: 'Invoice.pdf' })).path).toEqual(['t', 'pdf', 'statement', 'wait', 'label']);
    expect(walk(branching, facts({ name: 'notes.txt' })).path).toEqual(['t', 'pdf']);
  });

  it('stops before a model question it has no answer to, and goes on with one', () => {
    const asking: FlowGraph = { ...branching, nodes: branching.nodes.map((n) => (n.id === 'statement' ? { id: 'statement', type: 'check', condition: { field: 'ask', question: 'Is this a bank statement?' } } : n)) };
    expect(walk(asking, facts())).toEqual({ path: ['t', 'pdf'], needs: 'statement' });
    expect(walk(asking, facts(), { statement: false }).path).toEqual(['t', 'pdf', 'statement', 'wait', 'label']);
    // The preview never asks: both sides are only maybe.
    const { sure, maybe } = reach(asking, facts());
    expect([...sure]).toEqual(['t', 'pdf', 'statement']);
    expect([...maybe].sort()).toEqual(['copy', 'label', 'wait']);
    expect(graphMatches(asking, facts())).toBe('ask');
    expect(graphMatches(asking, facts({ name: 'notes.txt' }))).toBe(false);
    expect(graphMatches(branching, facts())).toBe(true);
  });

  it('is due on a schedule when never run or when the period has passed', () => {
    const daily: FlowGraph = { ...branching, nodes: branching.nodes.map((n) => (n.type === 'trigger' ? { ...n, on: 'schedule', every: 'day' } : n)) };
    const now = Date.parse('2026-11-12T10:00:00Z');
    expect(scheduleDue(daily, null, now)).toBe(true);
    expect(scheduleDue(daily, '2026-11-12T00:00:00Z', now)).toBe(false);
    expect(scheduleDue(daily, '2026-11-11T09:00:00Z', now)).toBe(true);
    expect(scheduleDue(branching, null, now)).toBe(false);
  });
});

describe('a flow from before graphs', () => {
  it('becomes its conditions in a row, a wait when it asked first, then its actions', () => {
    const old = legacyFlowDefinition.parse({
      trigger: { on: 'schedule', every: 'week' },
      conditions: [{ field: 'folder', op: 'under', path: 'Bank' }, { field: 'extension', values: ['pdf'] }],
      actions: [{ type: 'label', value: 'sent' }, { type: 'copy', space: 'gestoria', folderId: 'f1' }],
      mode: 'ask', versions: 'every',
    });
    const graph = legacyToGraph(old, 'bank');
    expect(graphProblems(graph)).toEqual([]);
    expect(graph.versions).toBe('every');
    expect(graph.nodes[0]).toEqual({ id: 'trigger', type: 'trigger', on: 'schedule', every: 'week', spaces: ['bank'] });
    expect(walk(graph, facts()).path).toEqual(['trigger', 'check-1', 'check-2', 'approval', 'action-1', 'action-2']);
    expect(walk(graph, facts({ folderPath: 'Other' })).path).toEqual(['trigger', 'check-1']);
    const auto = legacyToGraph(legacyFlowDefinition.parse({ trigger: { on: 'arrived' }, actions: [{ type: 'label', value: 'x' }], mode: 'auto' }), 'bank');
    expect(auto.edges).toEqual([{ from: 'trigger', to: 'action-1', branch: 'next' }]);
  });
});
