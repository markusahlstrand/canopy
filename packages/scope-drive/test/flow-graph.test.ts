import { describe, expect, it } from 'vitest';
import {
  capturesOn, copyPaths, fillTemplate, folderCaptures, patternProblem, templateProblem,
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

describe('folder patterns and path templates', () => {
  it('takes names from a folder path that fits, level by level', () => {
    expect(folderCaptures('Client invoices/{year}/{month}', 'Client invoices/2026/09')).toEqual({ year: '2026', month: '09' });
    expect(folderCaptures('*/{year}', 'Supplier invoices/2026')).toEqual({ year: '2026' });
    expect(folderCaptures('Client invoices/{year}/{month}', 'Client invoices/2026')).toBeNull();
    expect(folderCaptures('Client invoices/{year}/{month}', 'Client invoices/2026/09/extra')).toBeNull();
    expect(folderCaptures('Client invoices/{year}', 'client invoices/2026')).toBeNull();
    expect(folderCaptures('', '')).toEqual({});
  });

  it('fills a template, and says which name is missing', () => {
    expect(fillTemplate('{year}/{month}', { year: '2026', month: '09' })).toBe('2026/09');
    expect(fillTemplate(' Facturas / {year}-{month} ', { year: '2026', month: '09' })).toBe('Facturas/2026-09');
    expect(fillTemplate('', {})).toBe('');
    expect(() => fillTemplate('{year}/{month}', { year: '2026' })).toThrow('{month}');
    expect(() => fillTemplate('{x}', { x: '..' })).toThrow('not a folder path');
  });

  it('names what is wrong with a pattern or template', () => {
    expect(patternProblem('Client invoices/{year}/{month}')).toBeNull();
    expect(patternProblem('Invoices/{year}-x')).toMatch(/whole folder level/);
    expect(patternProblem('{Year}')).toMatch(/lowercase/);
    expect(patternProblem('{y}/{y}')).toMatch(/twice/);
    expect(templateProblem('{year}/{month}')).toBeNull();
    expect(templateProblem('{year')).toMatch(/without its pair/);
    expect(templateProblem('../{year}')).toMatch(/\.\./);
    // A folder name can't hold a backslash: refused when the flow is saved, not each time it runs.
    expect(templateProblem('DOC\\{year}')).toMatch(/has a \\ in it/);
  });

  const byMonth = (copy: Record<string, unknown> = {}): FlowGraph => ({
    versions: 'first',
    nodes: [
      { id: 't', type: 'trigger', on: 'arrived', spaces: ['qonto'] },
      { id: 'pdf', type: 'check', condition: { field: 'extension', values: ['pdf'] } },
      { id: 'month', type: 'check', condition: { field: 'folder', op: 'matches', path: 'Client invoices/{year}/{month}' } },
      { id: 'copy', type: 'copy', space: 'a3doc', folderId: 'root', alsoIn: [], subfolder: 'DOC/{year}/{month}', ...copy },
    ],
    edges: [
      { from: 't', to: 'pdf', branch: 'next' },
      { from: 'pdf', to: 'month', branch: 'yes' },
      { from: 'month', to: 'copy', branch: 'yes' },
    ],
  });

  it('accepts a copy whose names a pattern takes on every way to it', () => {
    expect(graphProblems(byMonth())).toEqual([]);
  });

  it('refuses a name nothing takes, or one taken only on No', () => {
    expect(messages(byMonth({ subfolder: '{year}/{quarter}' }))[0]).toMatch(/Nothing takes \{quarter\}/);
    const onNo = byMonth();
    onNo.edges[2] = { from: 'month', to: 'copy', branch: 'no' };
    expect(messages(onNo)[0]).toMatch(/Nothing takes \{year\}/);
  });

  it('refuses a name taken on one way in but not the other', () => {
    const graph = byMonth();
    graph.edges.push({ from: 'pdf', to: 'copy', branch: 'no' });
    expect(messages(graph)[0]).toMatch(/Nothing takes \{year\}/);
  });

  it('works out where a document goes from its own path', () => {
    const graph = byMonth({ alsoInPaths: ['Ventas/{year}', ' '] });
    const doc = facts({ name: 'F-12.pdf', folderPath: 'Client invoices/2026/09' });
    const { path } = walk(graph, doc);
    expect(path).toEqual(['t', 'pdf', 'month', 'copy']);
    const copy = graph.nodes.find((n) => n.type === 'copy')!;
    expect(copyPaths(copy as Extract<typeof copy, { type: 'copy' }>, capturesOn(graph, path, doc).get('copy')!)).toEqual({ subfolder: 'DOC/2026/09', alsoInPaths: ['Ventas/2026'] });
    expect(walk(graph, facts({ name: 'F-12.pdf', folderPath: 'Client invoices/2026' })).path).toEqual(['t', 'pdf', 'month']);
  });

  it('files each copy by what was taken before it, even when a later check takes the name again', () => {
    const graph: FlowGraph = {
      versions: 'first',
      nodes: [
        { id: 't', type: 'trigger', on: 'arrived', spaces: ['qonto'] },
        { id: 'first', type: 'check', condition: { field: 'folder', op: 'matches', path: '{year}/*' } },
        { id: 'early', type: 'copy', space: 'a3doc', folderId: 'root', alsoIn: [], subfolder: 'DOC/{year}' },
        { id: 'again', type: 'check', condition: { field: 'folder', op: 'matches', path: '*/{year}' } },
        { id: 'late', type: 'copy', space: 'a3doc', folderId: 'root', alsoIn: [], subfolder: 'DOC/{year}' },
      ],
      edges: [
        { from: 't', to: 'first', branch: 'next' },
        { from: 'first', to: 'early', branch: 'yes' },
        { from: 'early', to: 'again', branch: 'next' },
        { from: 'again', to: 'late', branch: 'yes' },
      ],
    };
    expect(graphProblems(graph)).toEqual([]);
    const doc = facts({ folderPath: '2026/09' });
    const { path } = walk(graph, doc);
    expect(path).toEqual(['t', 'first', 'early', 'again', 'late']);
    const captures = capturesOn(graph, path, doc);
    const copyOf = (id: string) => graph.nodes.find((n) => n.id === id) as Extract<FlowGraph['nodes'][number], { type: 'copy' }>;
    expect(copyPaths(copyOf('early'), captures.get('early')!).subfolder).toBe('DOC/2026');
    expect(copyPaths(copyOf('late'), captures.get('late')!).subfolder).toBe('DOC/09');
    expect(captures.get('first')).toEqual({});
  });
});
