/**
 * Flows as graphs: a trigger, then checks that branch Yes or No, a wait for approval, and actions.
 *
 * A flow belongs to the install, not to a space. Its trigger watches one or more spaces, and its
 * actions may write to others; the spaces it touches are read off the graph, never kept beside it,
 * so they cannot drift from what it does.
 *
 * The graph is a DAG with one trigger. A check has a Yes and a No exit; every other node has at
 * most one exit (`next`). Each document takes exactly one path, so the runner records the path and
 * a retry or an approval resumes it. A path holds at most one wait for approval: the run pauses
 * there once, and a person's yes takes it the rest of the way.
 *
 * Pure data and pure functions, shared by the worker (stores, runs), and the app (edits, previews).
 */
import { z } from '@substrat-run/contracts';
import {
  conditionHolds, copyFields, fillTemplate, flowCondition, folderCaptures, MAX_ALSO_IN, patternProblem, templateProblem, tokensOf,
  type FileFacts, type FlowCondition, type LegacyFlowDefinition,
} from './flows.js';

export const flowNodeId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'Use letters, digits, - and _');
/** A space, by the slug people see in its address. */
export const spaceSlug = z.string().min(1).max(64);

const position = z.object({ x: z.number().finite(), y: z.number().finite() }).optional();

export const triggerEvent = z.enum(['arrived', 'classified', 'schedule']);
export const schedulePeriod = z.enum(['hour', 'day', 'week', 'month']);

export const flowNode = z.discriminatedUnion('type', [
  /** Where the flow starts: what happened, in which spaces. A schedule offers what arrived since its last run. */
  z.object({
    id: flowNodeId, type: z.literal('trigger'), position,
    on: triggerEvent, every: schedulePeriod.optional(),
    spaces: z.array(spaceSlug).min(1).max(10),
  }),
  /** One condition, with a Yes and a No exit. */
  z.object({ id: flowNodeId, type: z.literal('check'), position, condition: flowCondition }),
  /** The run waits here for a person to approve or dismiss. */
  z.object({ id: flowNodeId, type: z.literal('approval'), position }),
  /** Copy the document into a folder of a space (this one or another). */
  z.object({ id: flowNodeId, type: z.literal('copy'), position, ...copyFields }),
  /** Add a label to the document where it is. */
  z.object({ id: flowNodeId, type: z.literal('label'), position, value: z.string().trim().min(1).max(100) }),
]);
export type FlowNode = z.infer<typeof flowNode>;
export type FlowNodeType = FlowNode['type'];
export type TriggerNode = Extract<FlowNode, { type: 'trigger' }>;
export type CheckNode = Extract<FlowNode, { type: 'check' }>;
export type ActionNode = Extract<FlowNode, { type: 'copy' | 'label' }>;

export const flowBranch = z.enum(['yes', 'no', 'next']);
export type FlowBranch = z.infer<typeof flowBranch>;
export const flowEdge = z.object({ from: flowNodeId, to: flowNodeId, branch: flowBranch });
export type FlowEdge = z.infer<typeof flowEdge>;

export const MAX_FLOW_NODES = 40;

/** The graph without its rules: what the editor holds while someone is still drawing. */
export const flowGraphShape = z.object({
  nodes: z.array(flowNode).min(1).max(MAX_FLOW_NODES),
  edges: z.array(flowEdge).max(MAX_FLOW_NODES * 2),
  /** `first`: act on a document once. `every`: again for each new version. */
  versions: z.enum(['first', 'every']).default('first'),
});
export type FlowGraph = z.infer<typeof flowGraphShape>;

/** A graph that can run: every rule in `graphProblems` holds. */
export const flowGraph = flowGraphShape.superRefine((graph, ctx) => {
  for (const problem of graphProblems(graph)) ctx.addIssue({ code: 'custom', message: problem.message, path: problem.node ? ['nodes', problem.node] : [] });
});

export const isAction = (node: FlowNode): node is ActionNode => node.type === 'copy' || node.type === 'label';

export interface GraphProblem { message: string; node?: string }

/**
 * What stops a graph from running, in words for the person drawing it. Empty when it can run.
 * The editor shows these on the nodes; saving refuses a graph with any.
 */
export function graphProblems(graph: Pick<FlowGraph, 'nodes' | 'edges'>): GraphProblem[] {
  const problems: GraphProblem[] = [];
  const byId = new Map<string, FlowNode>();
  for (const node of graph.nodes) {
    if (byId.has(node.id)) problems.push({ message: `Two steps share the id '${node.id}'.`, node: node.id });
    byId.set(node.id, node);
  }
  const triggers = graph.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) problems.push({ message: triggers.length ? 'A flow starts at one trigger.' : 'A flow needs a trigger: what starts it.' });
  for (const t of triggers) {
    if (t.on === 'schedule' && !t.every) problems.push({ message: 'Say how often the schedule runs.', node: t.id });
    if (t.on !== 'schedule' && t.every) problems.push({ message: 'Only a schedule runs every hour, day, week or month.', node: t.id });
    if (new Set(t.spaces).size !== t.spaces.length) problems.push({ message: 'A space is listed twice.', node: t.id });
  }
  if (!graph.nodes.some(isAction)) problems.push({ message: 'A flow needs at least one action: copy or label.' });
  for (const node of graph.nodes) {
    if (node.type === 'check' && node.condition.field === 'folder' && node.condition.op === 'matches') {
      const problem = patternProblem(node.condition.path);
      if (problem) problems.push({ message: problem, node: node.id });
    }
    if (node.type === 'copy') {
      for (const template of [node.subfolder ?? '', ...(node.alsoInPaths ?? [])]) {
        const problem = templateProblem(template);
        if (problem) problems.push({ message: problem, node: node.id });
      }
      if (node.alsoIn.length + (node.alsoInPaths?.length ?? 0) > MAX_ALSO_IN) {
        problems.push({ message: `A document goes in at most ${MAX_ALSO_IN} more categories.`, node: node.id });
      }
    }
  }

  const out = new Map<string, FlowEdge[]>();
  for (const edge of graph.edges) {
    const from = byId.get(edge.from), to = byId.get(edge.to);
    if (!from || !to) { problems.push({ message: 'A connection points at a step that is gone.' }); continue; }
    if (to.type === 'trigger') problems.push({ message: 'Nothing leads back into the trigger.', node: to.id });
    if (from.type === 'check' ? edge.branch === 'next' : edge.branch !== 'next') {
      problems.push({ message: from.type === 'check' ? 'A check leads on by Yes or No.' : 'Only a check has Yes and No exits.', node: from.id });
    }
    const list = out.get(edge.from) ?? [];
    if (list.some((e) => e.branch === edge.branch)) problems.push({ message: from.type === 'check' ? `A check has one ${edge.branch === 'yes' ? 'Yes' : 'No'} exit.` : 'A step leads to one next step.', node: from.id });
    list.push(edge);
    out.set(edge.from, list);
  }
  for (const node of graph.nodes) {
    const exits = out.get(node.id) ?? [];
    if (node.type === 'trigger' && !exits.length) problems.push({ message: 'Connect the trigger to the first step.', node: node.id });
    if (node.type === 'check' && !exits.length) problems.push({ message: 'This check leads nowhere: connect Yes or No.', node: node.id });
    if (node.type === 'approval' && !exits.length) problems.push({ message: 'Connect what happens once you approve.', node: node.id });
  }

  // No loops, everything reachable, at most one approval on any path.
  const trigger = triggers[0];
  if (trigger && byId.get(trigger.id) === trigger) {
    const state = new Map<string, 'open' | 'done'>();
    const approvals = new Map<string, number>(); // most approvals on a path from here to an end
    let looped = false;
    const visit = (id: string): number => {
      const seen = state.get(id);
      if (seen === 'open') { looped = true; return 0; }
      if (seen === 'done') return approvals.get(id) ?? 0;
      state.set(id, 'open');
      let most = 0;
      for (const edge of out.get(id) ?? []) if (byId.has(edge.to)) most = Math.max(most, visit(edge.to));
      const here = most + (byId.get(id)?.type === 'approval' ? 1 : 0);
      state.set(id, 'done');
      approvals.set(id, here);
      return here;
    };
    const most = visit(trigger.id);
    if (looped) problems.push({ message: 'The flow loops back on itself. Each path has to end.' });
    if (most > 1) problems.push({ message: 'A path waits for approval once at most.' });
    for (const node of graph.nodes) {
      if (!state.has(node.id)) problems.push({ message: 'This step is not connected to the trigger.', node: node.id });
    }
    if (!looped) {
      const taken = capturedBefore(graph);
      for (const node of graph.nodes) {
        if (node.type !== 'copy' || !state.has(node.id)) continue;
        const have = taken.get(node.id) ?? new Set<string>();
        const used = tokensOf([node.subfolder ?? '', ...(node.alsoInPaths ?? [])].join('/'));
        const missing = used.filter((name) => !have.has(name));
        if (missing.length) {
          problems.push({ message: `Nothing takes {${missing[0]}} on every way here: put a check "folder matches", like Invoices/{year}/{month}, before this step, on its Yes side.`, node: node.id });
        }
      }
    }
  }
  return problems;
}

/** The names a check's folder pattern takes, when it is one; none otherwise. */
const patternTokens = (node: FlowNode): string[] =>
  node.type === 'check' && node.condition.field === 'folder' && node.condition.op === 'matches' ? tokensOf(node.condition.path) : [];

/**
 * By node: the names every way from the trigger to it has taken. A folder pattern takes its names
 * on its Yes exit only (on No, the path did not fit). For a graph without loops.
 */
export function capturedBefore(graph: Pick<FlowGraph, 'nodes' | 'edges'>): Map<string, Set<string>> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const into = new Map<string, FlowEdge[]>();
  for (const edge of graph.edges) if (byId.has(edge.from) && byId.has(edge.to)) into.set(edge.to, [...(into.get(edge.to) ?? []), edge]);
  const memo = new Map<string, Set<string>>();
  const open = new Set<string>();
  const at = (id: string): Set<string> => {
    const known = memo.get(id);
    if (known) return known;
    if (open.has(id)) return new Set();
    open.add(id);
    let have: Set<string> | undefined;
    for (const edge of into.get(id) ?? []) {
      const came = new Set<string>(at(edge.from));
      if (edge.branch === 'yes') for (const name of patternTokens(byId.get(edge.from)!)) came.add(name);
      const before: Set<string> | undefined = have;
      have = before === undefined ? came : new Set<string>([...before].filter((name) => came.has(name)));
    }
    open.delete(id);
    const result = have ?? new Set<string>();
    memo.set(id, result);
    return result;
  };
  for (const node of graph.nodes) at(node.id);
  return memo;
}

/**
 * The names the folder patterns on a document's path took from it. A pattern that did not fit
 * took nothing (the path went on by No).
 */
export function capturesOn(graph: Pick<FlowGraph, 'nodes'>, path: readonly string[], facts: FileFacts): Record<string, string> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const captures: Record<string, string> = {};
  for (const id of path) {
    const node = byId.get(id);
    if (node?.type !== 'check' || node.condition.field !== 'folder' || node.condition.op !== 'matches') continue;
    Object.assign(captures, folderCaptures(node.condition.path, facts.folderPath) ?? {});
  }
  return captures;
}

/** Where a copy files one document: below its folder, and in which more categories by path. Throws when a name has no value. */
export function copyPaths(node: Extract<FlowNode, { type: 'copy' }>, captures: Readonly<Record<string, string>>): { subfolder: string; alsoInPaths: string[] } {
  const alsoInPaths = [...new Set((node.alsoInPaths ?? []).filter((t) => t.trim()).map((t) => fillTemplate(t, captures)))];
  return { subfolder: fillTemplate(node.subfolder ?? '', captures), alsoInPaths };
}

/** The trigger of a graph that passed `graphProblems`. */
export const triggerOf = (graph: Pick<FlowGraph, 'nodes'>): TriggerNode => graph.nodes.find((n): n is TriggerNode => n.type === 'trigger')!;

/** The spaces a flow touches: those it watches, and those it copies into. */
export function spacesOf(graph: Pick<FlowGraph, 'nodes'>): { watch: string[]; write: string[] } {
  const watch = new Set<string>(), write = new Set<string>();
  for (const node of graph.nodes) {
    if (node.type === 'trigger') node.spaces.forEach((s) => watch.add(s));
    if (node.type === 'copy') write.add(node.space);
  }
  return { watch: [...watch], write: [...write] };
}

/** Model answers by check node id. */
export type Answers = Readonly<Record<string, boolean>>;

/** One document's path through a flow. */
export interface Walk {
  /** The nodes passed, trigger first. */
  path: string[];
  /** The check whose model question has no answer yet: the walk stops before it. */
  needs?: string;
}

const exitOf = (graph: Pick<FlowGraph, 'edges'>, from: string, branch: FlowBranch) =>
  graph.edges.find((e) => e.from === from && e.branch === branch)?.to;

/**
 * The path one document takes, given the model's answers so far. Plain checks are decided from
 * the facts; a model question without an answer stops the walk (`needs`), for the runner to ask.
 */
export function walk(graph: Pick<FlowGraph, 'nodes' | 'edges'>, facts: FileFacts, answers: Answers = {}): Walk {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const path: string[] = [];
  let at: string | undefined = triggerOf(graph).id;
  // A DAG ends within as many steps as it has nodes; the bound only guards a graph that skipped validation.
  for (let guard = 0; at && guard <= graph.nodes.length; guard++) {
    const node = byId.get(at);
    if (!node) break;
    if (node.type === 'check') {
      const held = conditionHolds(node.condition, facts);
      const yes = held === 'ask' ? answers[node.id] : held;
      if (yes === undefined) return { path, needs: node.id };
      path.push(node.id);
      at = exitOf(graph, node.id, yes ? 'yes' : 'no');
      continue;
    }
    path.push(node.id);
    at = exitOf(graph, node.id, 'next');
  }
  return { path };
}

/**
 * Where a document could go without asking the model: the nodes it surely reaches, and those it
 * reaches only on some answer. For the preview, which never calls a model.
 */
export function reach(graph: Pick<FlowGraph, 'nodes' | 'edges'>, facts: FileFacts): { sure: Set<string>; maybe: Set<string> } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const sure = new Set<string>(), maybe = new Set<string>();
  const go = (id: string | undefined, certain: boolean, depth: number) => {
    const node = id ? byId.get(id) : undefined;
    if (!node || depth > graph.nodes.length) return;
    (certain ? sure : maybe).add(node.id);
    if (node.type !== 'check') return go(exitOf(graph, node.id, 'next'), certain, depth + 1);
    const held = conditionHolds(node.condition, facts);
    if (held === 'ask') {
      go(exitOf(graph, node.id, 'yes'), false, depth + 1);
      go(exitOf(graph, node.id, 'no'), false, depth + 1);
    } else go(exitOf(graph, node.id, held ? 'yes' : 'no'), certain, depth + 1);
  };
  go(triggerOf(graph).id, true, 0);
  for (const id of sure) maybe.delete(id);
  return { sure, maybe };
}

/** Whether a document would reach an action: surely, maybe (on a model's answer), or not at all. */
export function graphMatches(graph: Pick<FlowGraph, 'nodes' | 'edges'>, facts: FileFacts): boolean | 'ask' {
  const { sure, maybe } = reach(graph, facts);
  const acts = (ids: Set<string>) => graph.nodes.some((n) => isAction(n) && ids.has(n.id));
  return acts(sure) ? true : acts(maybe) ? 'ask' : false;
}

/** Whether a trigger reacts to a queued arrival or classification in a space. */
export function reactsTo(graph: Pick<FlowGraph, 'nodes'>, event: 'arrived' | 'classified', space: string): boolean {
  const trigger = triggerOf(graph);
  return trigger.on === event && trigger.spaces.includes(space);
}

const PERIOD_MS = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 } as const;

/** Whether a scheduled flow is due in a space at `now`, given when it last ran there (never ⇒ due). */
export function scheduleDue(graph: Pick<FlowGraph, 'nodes'>, lastRunAt: string | null, now: number): boolean {
  const trigger = triggerOf(graph);
  if (trigger.on !== 'schedule' || !trigger.every) return false;
  if (!lastRunAt) return true;
  return now - Date.parse(lastRunAt) >= PERIOD_MS[trigger.every];
}

/** Whether any check asks the model: each match then costs a call. */
export const graphAsksModel = (graph: Pick<FlowGraph, 'nodes'>) => graph.nodes.some((n) => n.type === 'check' && n.condition.field === 'ask');

/**
 * A space-local flow from before flows were graphs, as a graph: its conditions in a row (Yes leads
 * on, No ends), then a wait for approval when it asked first, then its actions in a row.
 */
export function legacyToGraph(definition: LegacyFlowDefinition, space: string): FlowGraph {
  const t = definition.trigger;
  const nodes: FlowNode[] = [{ id: 'trigger', type: 'trigger', on: t.on, ...(t.on === 'schedule' ? { every: t.every } : {}), spaces: [space] }];
  const edges: FlowEdge[] = [];
  let last = 'trigger', branch: FlowBranch = 'next';
  const link = (id: string, next: FlowBranch) => { edges.push({ from: last, to: id, branch }); last = id; branch = next; };
  definition.conditions.forEach((condition: FlowCondition, i) => {
    nodes.push({ id: `check-${i + 1}`, type: 'check', condition });
    link(`check-${i + 1}`, 'yes');
  });
  if (definition.mode === 'ask') { nodes.push({ id: 'approval', type: 'approval' }); link('approval', 'next'); }
  definition.actions.forEach((action, i) => {
    const id = `action-${i + 1}`;
    nodes.push(action.type === 'copy' ? { id, type: 'copy', space: action.space, folderId: action.folderId, alsoIn: action.alsoIn } : { id, type: 'label', value: action.value });
    link(id, 'next');
  });
  return { nodes, edges, versions: definition.versions };
}

/** A flow as the app reads it. */
export const storedFlow = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  graph: flowGraphShape,
  /** Who saved it last, as people see them (the flow acts as this login). */
  author: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  failures: z.number().int(),
  pausedReason: z.string().nullable(),
});
export type StoredFlow = z.infer<typeof storedFlow>;
