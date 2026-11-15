/**
 * A flow drawn as steps and arrows (React Flow). The graph stays the source of truth: React Flow
 * only holds what it must between renders (measured sizes, a drag in progress), and every edit —
 * connect, delete, move — goes back as a new graph.
 */
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background, BackgroundVariant, Controls, Handle, MarkerType, Position, ReactFlow, applyNodeChanges,
  type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps, type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Icon, cn } from '@canopy/ui';
import type { FlowBranch } from '@canopy/scope-drive/spec/model';
import { connect, describeStep, disconnect, placeSteps, removeSteps, type FlowGraph, type FlowNode, type Names } from './flow-graph-edit';
import { STEP_WIDTH } from './flow-layout';

export interface StepData {
  text: string;
  kind: FlowNode['type'];
  problems: string[];
  /** Preview counts, when a fresh preview is showing. */
  reach?: number;
  maybe?: number;
  [key: string]: unknown;
}

const KIND: Record<FlowNode['type'], { icon: string; label: string; tone: string }> = {
  trigger: { icon: 'radio', label: 'Start', tone: 'text-primary' },
  check: { icon: 'filter', label: 'Check', tone: 'text-amber-600 dark:text-amber-400' },
  approval: { icon: 'inbox', label: 'Approval', tone: 'text-sky-600 dark:text-sky-400' },
  copy: { icon: 'send', label: 'Copy', tone: 'text-emerald-600 dark:text-emerald-400' },
  label: { icon: 'tag', label: 'Label', tone: 'text-violet-600 dark:text-violet-400' },
};

const handleClass = '!h-3 !w-3 !border-2 !border-background !bg-muted-foreground';

function StepCardImpl({ data, selected }: NodeProps) {
  const d = data as StepData;
  const kind = KIND[d.kind];
  const broken = d.problems.length > 0;
  return (
    <div style={{ width: STEP_WIDTH }}
      className={cn('relative rounded-xl border bg-card px-3 py-2 text-card-foreground shadow-sm',
        broken && 'border-destructive', selected && (broken ? 'ring-2 ring-destructive/40' : 'border-primary ring-2 ring-primary/30'))}>
      {d.kind !== 'trigger' ? <Handle id="in" type="target" position={Position.Left} className={handleClass} /> : null}
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <span className={kind.tone}><Icon name={kind.icon} size={13} /></span>{kind.label}
        {d.reach !== undefined ? (
          <span className="ml-auto flex gap-1 normal-case tracking-normal" aria-label={`${d.reach} documents${d.maybe ? `, ${d.maybe} more maybe` : ''}`}>
            <span className="rounded-full bg-primary/10 px-1.5 text-primary">{d.reach}</span>
            {d.maybe ? <span className="rounded-full bg-muted px-1.5">+{d.maybe} maybe</span> : null}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-[13px] leading-snug">{d.text}</p>
      {broken ? <ul className="mt-1 space-y-0.5 text-[11px] text-destructive">{d.problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
      {d.kind === 'check' ? <>
        <Handle id="yes" type="source" position={Position.Right} style={{ top: '35%' }} className={cn(handleClass, '!bg-emerald-600')} />
        <span className="pointer-events-none absolute -right-8 text-[10px] font-medium text-emerald-700 dark:text-emerald-400" style={{ top: 'calc(35% - 16px)' }}>Yes</span>
        <Handle id="no" type="source" position={Position.Right} style={{ top: '70%' }} className={cn(handleClass, '!bg-rose-600')} />
        <span className="pointer-events-none absolute -right-7 text-[10px] font-medium text-rose-700 dark:text-rose-400" style={{ top: 'calc(70% + 4px)' }}>No</span>
      </> : <Handle id="next" type="source" position={Position.Right} className={handleClass} />}
    </div>
  );
}
const StepCard = memo(StepCardImpl);
const nodeTypes = { step: StepCard };
const proOptions = { hideAttribution: true };

/** Light or dark, following the `.dark` class the app sets on the document. */
function useColorMode(): 'light' | 'dark' {
  const read = () => (typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  const [mode, setMode] = useState<'light' | 'dark'>(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setMode(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return mode;
}

const edgeId = (from: string, branch: FlowBranch) => `${from}|${branch}`;

export function FlowCanvas({ graph, names, problems, counts, selected, busy, onSelect, onChange }: {
  graph: FlowGraph; names: Names;
  /** Problems by step id. */
  problems: ReadonlyMap<string, string[]>;
  counts: { reach: Record<string, number>; maybe: Record<string, number> } | null;
  selected: string | null; busy: boolean;
  onSelect: (id: string | null) => void;
  onChange: (graph: FlowGraph) => void;
}) {
  const colorMode = useColorMode();
  const [nodes, setNodes] = useState<Node[]>([]);
  // A step added (or a layout made) can land outside the view: bring the whole flow back into it.
  const [view, setView] = useState<ReactFlowInstance | null>(null);
  const count = graph.nodes.length;
  const laidOut = graph.nodes.every((n) => n.position);
  useEffect(() => {
    if (!view) return;
    // After React Flow has measured the new card: fitting before that leaves it out.
    const timer = setTimeout(() => { void view.fitView({ maxZoom: 1, duration: 200, padding: 0.15 }); }, 80);
    return () => clearTimeout(timer);
  }, [view, count, laidOut]);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);

  // Drawn from the graph, keeping what React Flow measured and any drag in progress.
  useEffect(() => {
    setNodes((previous) => {
      const old = new Map(previous.map((n) => [n.id, n]));
      return graph.nodes.map((step): Node => {
        const was = old.get(step.id);
        const data: StepData = {
          text: describeStep(step, names), kind: step.type, problems: problems.get(step.id) ?? [],
          ...(counts ? { reach: counts.reach[step.id] ?? 0, maybe: counts.maybe[step.id] ?? 0 } : {}),
        };
        return {
          ...was, id: step.id, type: 'step', data,
          position: was?.dragging ? was.position : step.position ?? was?.position ?? { x: 0, y: 0 },
          selected: step.id === selected, deletable: step.type !== 'trigger' && !busy,
          ariaLabel: `${KIND[step.type].label}: ${data.text}`,
        };
      });
    });
  }, [graph, names, problems, counts, selected, busy]);

  const edges = useMemo<Edge[]>(() => graph.edges.map((e) => {
    const id = edgeId(e.from, e.branch);
    // The Yes and No handles carry the words; the edge keeps their colour, so a long one still says which it is.
    const color = e.branch === 'yes' ? '#059669' : e.branch === 'no' ? '#e11d48' : undefined;
    return {
      id, source: e.from, target: e.to, sourceHandle: e.branch, targetHandle: 'in',
      ariaLabel: e.branch === 'yes' ? 'If yes' : e.branch === 'no' ? 'If no' : 'Then',
      selected: id === selectedEdge, deletable: !busy,
      markerEnd: { type: MarkerType.ArrowClosed, ...(color ? { color } : {}) },
      style: color ? { stroke: color } : undefined,
    };
  }), [graph.edges, selectedEdge, busy]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Removal goes through onDelete, which sees nodes and edges together; selection is the editor's.
    for (const c of changes) if (c.type === 'select' && c.selected) onSelect(c.id);
    setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type !== 'remove' && c.type !== 'select'), ns));
  }, [onSelect]);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const c of changes) if (c.type === 'select') setSelectedEdge(c.selected ? c.id : null);
  }, []);
  const onConnect = useCallback((c: Connection) => {
    if (!c.sourceHandle || busy) return;
    onChange(connect(graph, c.source, c.sourceHandle as FlowBranch, c.target));
  }, [graph, busy, onChange]);
  const onDelete = useCallback(({ nodes: gone, edges: cut }: { nodes: Node[]; edges: Edge[] }) => {
    let next = removeSteps(graph, gone.map((n) => n.id));
    for (const e of cut) next = disconnect(next, e.source, e.sourceHandle as FlowBranch);
    if (gone.some((n) => n.id === selected)) onSelect(null);
    onChange(next);
  }, [graph, selected, onChange, onSelect]);
  const onNodeDragStop = useCallback((_: unknown, _node: Node, moved: Node[]) => {
    onChange(placeSteps(graph, new Map(moved.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }]))));
  }, [graph, onChange]);

  return (
    <ReactFlow
      nodes={nodes} edges={edges} nodeTypes={nodeTypes} colorMode={colorMode} proOptions={proOptions}
      onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onDelete={onDelete}
      onNodeDragStop={onNodeDragStop}
      onNodeClick={(_, node) => { setSelectedEdge(null); onSelect(node.id); }}
      onPaneClick={() => { setSelectedEdge(null); onSelect(null); }}
      isValidConnection={(c) => c.source !== c.target && graph.nodes.find((n) => n.id === c.target)?.type !== 'trigger'}
      nodesDraggable={!busy} nodesConnectable={!busy}
      deleteKeyCode={['Backspace', 'Delete']}
      fitView fitViewOptions={{ maxZoom: 1 }} minZoom={0.2} onInit={setView}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
