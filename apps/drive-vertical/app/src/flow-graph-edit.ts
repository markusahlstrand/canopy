/**
 * Editing a flow's graph, as pure functions: what the canvas, the palette and the inspector do to
 * it, kept out of React so tests can drive them without dragging anything.
 *
 * The graph is the one source of truth; React Flow's nodes and edges are drawn from it.
 */
import { graphProblems, isAction, type FlowBranch, type FlowCondition, type FlowEdge, type FlowGraph, type FlowNode, type GraphProblem } from '@canopy/scope-drive/spec/model';
import type { SpaceCategory } from '../../src/space-settings';

export type StepType = 'check' | 'approval' | 'copy' | 'label';
type XY = { x: number; y: number };

/** A new flow: just the trigger, watching the given spaces. */
export const newGraph = (spaces: string[] = []): FlowGraph => ({
  nodes: [{ id: 'trigger', type: 'trigger', on: 'arrived', spaces, position: { x: 0, y: 0 } }],
  edges: [],
  versions: 'first',
});

/** The exits a step has: Yes and No for a check, one `next` for everything else. */
export const exitsOf = (node: FlowNode): FlowBranch[] => (node.type === 'check' ? ['yes', 'no'] : ['next']);

export const exitTo = (graph: FlowGraph, from: string, branch: FlowBranch) =>
  graph.edges.find((e) => e.from === from && e.branch === branch)?.to;

function freshId(graph: FlowGraph, type: StepType): string {
  const taken = new Set(graph.nodes.map((n) => n.id));
  for (let i = 1; ; i++) if (!taken.has(`${type}-${i}`)) return `${type}-${i}`;
}

export function blankCondition(field: FlowCondition['field'], categories: readonly SpaceCategory[] = []): FlowCondition {
  switch (field) {
    case 'folder': return { field, op: 'under', path: '' };
    case 'name': return { field, op: 'contains', value: '' };
    case 'extension': return { field, values: ['pdf'] };
    case 'category': return { field, values: categories[0] ? [categories[0].id] : [], minConfidence: 0.7 };
    case 'label': return { field, value: '' };
    case 'ask': return { field, question: '' };
  }
}

function blankStep(type: StepType, id: string, position: XY): FlowNode {
  switch (type) {
    case 'check': return { id, type, position, condition: blankCondition('extension') };
    case 'approval': return { id, type, position };
    case 'copy': return { id, type, position, space: '', folderId: '', alsoIn: [] };
    case 'label': return { id, type, position, value: '' };
  }
}

/**
 * Add a step. With `after`, it is placed to the right of that step and joined to its first free
 * exit (a check's Yes, then No), which is how people mostly build: one step after the other.
 */
export function addStep(graph: FlowGraph, type: StepType, after?: string): { graph: FlowGraph; id: string } {
  const id = freshId(graph, type);
  // Nothing selected: join the newest step that still has a free exit (the trigger, at first),
  // so building a flow step by step never leaves the new one loose.
  const free = (n: FlowNode) => exitsOf(n).some((b) => !exitTo(graph, n.id, b));
  const from = after ? graph.nodes.find((n) => n.id === after) : [...graph.nodes].reverse().find(free);
  const branch = from ? exitsOf(from).find((b) => !exitTo(graph, from.id, b)) : undefined;
  const base = from?.position ?? rightmost(graph);
  // Below whatever already hangs off the same step, so a No branch doesn't land on the Yes one.
  const siblings = from ? graph.edges.filter((e) => e.from === from.id).length : 0;
  const position = { x: base.x + 280, y: base.y + siblings * 140 };
  const next: FlowGraph = { ...graph, nodes: [...graph.nodes, blankStep(type, id, position)] };
  return { graph: from && branch ? connect(next, from.id, branch, id) : next, id };
}

function rightmost(graph: FlowGraph): XY {
  const placed = graph.nodes.map((n) => n.position).filter((p): p is XY => Boolean(p));
  if (!placed.length) return { x: 0, y: 0 };
  return placed.reduce((a, b) => (b.x > a.x ? b : a));
}

/**
 * Join an exit to a step. An exit leads to one step, so this replaces whatever it led to.
 * Refuses what can never be right: into the trigger, onto itself, or an exit the step lacks.
 */
export function connect(graph: FlowGraph, from: string, branch: FlowBranch, to: string): FlowGraph {
  const source = graph.nodes.find((n) => n.id === from), target = graph.nodes.find((n) => n.id === to);
  if (!source || !target || from === to || target.type === 'trigger' || !exitsOf(source).includes(branch)) return graph;
  const edges = graph.edges.filter((e) => !(e.from === from && e.branch === branch));
  return { ...graph, edges: [...edges, { from, to, branch }] };
}

export const disconnect = (graph: FlowGraph, from: string, branch: FlowBranch): FlowGraph =>
  ({ ...graph, edges: graph.edges.filter((e) => !(e.from === from && e.branch === branch)) });

/** Remove steps and every connection to or from them. The trigger stays: a flow always has one. */
export function removeSteps(graph: FlowGraph, ids: readonly string[]): FlowGraph {
  const gone = new Set(ids.filter((id) => graph.nodes.find((n) => n.id === id)?.type !== 'trigger'));
  if (!gone.size) return graph;
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => !gone.has(n.id)),
    edges: graph.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)),
  };
}

/** Replace one step, keeping its id and where it sits. */
export const updateStep = (graph: FlowGraph, node: FlowNode): FlowGraph => ({
  ...graph,
  nodes: graph.nodes.map((n) => (n.id === node.id ? { ...node, position: n.position } : n)),
});

export const placeSteps = (graph: FlowGraph, positions: ReadonlyMap<string, XY>): FlowGraph => ({
  ...graph,
  nodes: graph.nodes.map((n) => (positions.has(n.id) ? { ...n, position: positions.get(n.id)! } : n)),
});

/** Whether the canvas has to lay the graph out first: a flow from before graphs has no positions. */
export const needsLayout = (graph: FlowGraph) => graph.nodes.some((n) => !n.position);

/** The graph as it acts: where steps sit on the canvas doesn't change what a preview would show. */
export const behaviourKey = (graph: FlowGraph) =>
  JSON.stringify([graph.nodes.map(({ position: _p, ...rest }) => rest), graph.edges, graph.versions]);

/**
 * What a step still needs filled in before it can be saved. `graphProblems` checks the shape of
 * the graph; this checks the fields the server's schema would refuse.
 */
export function stepProblems(graph: FlowGraph): GraphProblem[] {
  const problems: GraphProblem[] = [];
  for (const n of graph.nodes) {
    const add = (message: string) => problems.push({ message, node: n.id });
    switch (n.type) {
      case 'trigger': if (!n.spaces.length) add('Choose at least one space to watch.'); break;
      case 'copy': if (!n.space) add('Choose a space to copy to.'); else if (!n.folderId) add('Choose a folder to copy to.'); break;
      case 'label': if (!n.value.trim()) add('Say which label to add.'); break;
      case 'check': {
        const c = n.condition;
        if ((c.field === 'name' || c.field === 'label') && !c.value.trim()) add('Fill in what to look for.');
        if (c.field === 'ask' && c.question.trim().length < 3) add('Write the question for the AI.');
        if ((c.field === 'category' || c.field === 'extension') && !c.values.length) add(c.field === 'category' ? 'Choose at least one category.' : 'Name at least one file type.');
        break;
      }
    }
  }
  return problems;
}

/** Everything that stops a graph from being saved, shape first. */
export const allProblems = (graph: FlowGraph): GraphProblem[] => [...graphProblems(graph), ...stepProblems(graph)];

/** Whether a copy into one of these spaces (a3doc's, which can't delete) can happen without a wait for approval on the way. */
export function copiesWithoutApproval(graph: FlowGraph, into: ReadonlySet<string>): boolean {
  const trigger = graph.nodes.find((n) => n.type === 'trigger');
  if (!trigger) return false;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const go = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const node = byId.get(id);
    if (!node || node.type === 'approval') return false;
    if (node.type === 'copy' && into.has(node.space)) return true;
    return graph.edges.filter((e) => e.from === id).some((e) => go(e.to));
  };
  return go(trigger.id);
}

export interface Names {
  space: (slug: string) => string;
  category: (id: string) => string;
  /** A folder's path in a space, when known. */
  folder: (space: string, folderId: string) => string | undefined;
}

const quoted = (text: string) => `‘${text}’`;
const list = (items: string[], joiner = ' or ') =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')}${joiner}${items[items.length - 1]}`;

/** A check as the question it asks of a document. */
export function describeCondition(c: FlowCondition, names: Pick<Names, 'category'>): string {
  switch (c.field) {
    case 'folder':
      if (c.op === 'matches') return `Is its folder like ${c.path || 'the top level'}?`;
      return c.op === 'is' ? `Is it in ${c.path || 'the top level'}?` : c.path ? `Is it in ${c.path}, or a folder in it?` : 'Is it anywhere in the space?';
    case 'name': return c.value.trim() ? (c.op === 'contains' ? `Does its name contain ${quoted(c.value)}?` : `Does its name match ${quoted(c.value)}?`) : 'Does its name…?';
    case 'extension': return c.values.length ? `Is it a ${list(c.values.map((v) => v.replace(/^\./, '').toUpperCase()))}?` : 'Is it a… file?';
    case 'category': return c.values.length ? `Is it a ${list(c.values.map(names.category))}?` : 'Is it in a category…?';
    case 'label': return c.value.trim() ? `Is it labelled ${quoted(c.value)}?` : 'Is it labelled…?';
    case 'ask': return c.question.trim() ? `Ask AI: ${c.question.trim()}` : 'Ask AI…';
  }
}

const EVERY: Record<string, string> = { hour: 'Every hour', day: 'Every day', week: 'Every week', month: 'Every month' };

/** A step in plain words: what the canvas card says. */
export function describeStep(node: FlowNode, names: Names): string {
  switch (node.type) {
    case 'trigger': {
      const where = node.spaces.length ? list(node.spaces.map(names.space), ', ') : 'no space yet';
      if (node.on === 'arrived') return `When a document arrives in ${where}`;
      if (node.on === 'classified') return `When a document in ${where} gets a category`;
      return `${EVERY[node.every ?? ''] ?? 'On a schedule'}, for what arrived in ${where}`;
    }
    case 'check': return describeCondition(node.condition, names);
    case 'approval': return 'Wait for your approval';
    case 'copy': {
      if (!node.space) return 'Copy to…';
      const folder = node.folderId ? names.folder(node.space, node.folderId) : undefined;
      const sub = node.subfolder?.trim();
      const where = folder && sub ? `${folder}/${sub}` : sub || folder;
      return `Copy to ${names.space(node.space)}${where ? ` › ${where}` : folder === '' ? ' › Top level' : ''}`;
    }
    case 'label': return node.value.trim() ? `Add label ${quoted(node.value.trim())}` : 'Add a label…';
  }
}

/** One line about a flow, for the list: its trigger and what it does. */
export function describeFlow(graph: FlowGraph, names: Names): string {
  const trigger = graph.nodes.find((n) => n.type === 'trigger');
  const actions = graph.nodes.filter(isAction).map((n) => {
    const text = describeStep(n, names);
    return text.charAt(0).toLowerCase() + text.slice(1);
  });
  const waits = graph.nodes.some((n) => n.type === 'approval');
  return `${trigger ? describeStep(trigger, names) : 'Not started by anything'}: ${actions.length ? list(actions, ', ') : 'does nothing yet'}${waits ? ', after you approve' : ''}.`;
}

export type { FlowEdge, FlowGraph, FlowNode };
