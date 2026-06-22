import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "../model-editor.css";
import { onNodeDragStart, onNodeDragStop } from "../node-drag-cursor";
import { Icon } from "@canopy/ui";
import { cn } from "@canopy/ui";
import { layeredPositions, type XY } from "./layout";
import type { SpecStep } from "./graph-types";
import type { SpecViewProps } from "./view-types";

/** The Flows tab is layout-controlled by the shell, mirroring the Entities tab. */
export interface FlowsTabProps extends SpecViewProps {
  /** Saved positions for the active view, by step id. Missing ⇒ auto-layout. */
  stepPositions: Record<string, XY>;
  onMoveStep: (id: string, xy: XY) => void;
  onResetSteps: () => void;
  hasStepOverrides: boolean;
  /** Active tag include-filter (empty ⇒ show all workflows). */
  tagFilter: string[];
}

interface StepNodeData extends Record<string, unknown> {
  step: SpecStep;
  resolvedOp: boolean;
  dim: boolean;
  errored: boolean;
  onPick: (id: string) => void;
}

function StepNodeImpl({ data, selected }: NodeProps) {
  const d = data as StepNodeData;
  const s = d.step;
  return (
    <div
      onClick={() => d.onPick(s.id)}
      className={cn("w-[210px] cursor-pointer rounded-xl border bg-card p-3 shadow-sm transition", d.dim && "opacity-30")}
      style={{
        borderColor: d.errored ? "var(--destructive)" : selected ? "var(--primary)" : "var(--border)",
        boxShadow: selected ? "0 0 0 2px var(--primary)" : undefined,
      }}
    >
      <Handle id="in" type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-2 !border-background !bg-muted-foreground" />
      <Handle id="out" type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-background !bg-muted-foreground" />
      <div className="flex items-center gap-1.5">
        <Icon name="circle-check" size={13} className="shrink-0 text-muted-foreground" />
        <span className="truncate text-[13px] font-semibold">{s.stepId}</span>
      </div>
      {s.operationId && (
        <div className={cn("mt-1.5 flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px]", d.resolvedOp ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive")}>
          <Icon name={d.resolvedOp ? "globe" : "alert-triangle"} size={10} />
          <span className="truncate">{s.operationId}</span>
        </div>
      )}
      {s.callsWorkflowId && <div className="mt-1.5 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">→ {s.callsWorkflowId}</div>}
      {!!s.successCriteria.length && <div className="mt-1.5 truncate font-mono text-[10px] text-muted-foreground">✓ {s.successCriteria[0]}</div>}
    </div>
  );
}
const StepNode = memo(StepNodeImpl);

/** Card width is fixed by `w-[210px]`. */
const STEP_WIDTH = 210;
// Step cards grow a row per optional detail; over-estimate so dagre never packs two
// into the same space (see the matching note in entities-tab).
function estimateStepHeight(s: SpecStep): number {
  return 48 + (s.operationId ? 26 : 0) + (s.callsWorkflowId ? 26 : 0) + (s.successCriteria.length ? 24 : 0);
}

function FlowLabelImpl({ data }: NodeProps) {
  const d = data as { label: string; tags?: string[] };
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-foreground/5 px-2.5 py-1 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
      <Icon name="board" size={13} className="inline" />
      {d.label}
      {d.tags?.map((t) => (
        <span key={t} className="rounded-full bg-accent px-1.5 py-0.5 font-mono text-[9px] normal-case tracking-normal text-accent-foreground">#{t}</span>
      ))}
    </div>
  );
}
const FlowLabel = memo(FlowLabelImpl);
const nodeTypes = { step: StepNode, flowLabel: FlowLabel };

// Shared fallback position (stable identity) for steps without a placed position.
const FALLBACK_POS = { x: 0, y: 0 };

function Graph({ graph, index, selection, related, onSelect, stepPositions, onMoveStep, onResetSteps, hasStepOverrides, tagFilter }: FlowsTabProps) {
  const { fitView } = useReactFlow();
  const errored = useMemo(
    () => new Set(graph.diagnostics.filter((d) => d.target?.kind === "step").map((d) => d.target!.id)),
    [graph.diagnostics],
  );
  // Tag filtering is whole-workflow here: a flow shows if it carries a selected tag.
  const flows = useMemo(
    () => (tagFilter.length ? graph.flows.filter((f) => f.tags?.some((t) => tagFilter.includes(t))) : graph.flows),
    [graph.flows, tagFilter],
  );

  // Per-flow auto-layout + label nodes. ELK is async, so we lay every flow out in
  // parallel, then stack them vertically. Keyed on `flows` alone (not `stepPositions`)
  // so dragging a step doesn't re-run the layout, and the previous result is kept while
  // a new one is in flight so a re-flow doesn't flash.
  const [layout, setLayout] = useState<{ labelByFlow: Map<string, Node>; stepBase: Map<string, XY> }>(() => ({
    labelByFlow: new Map(),
    stepBase: new Map(),
  }));
  useEffect(() => {
    let alive = true;
    (async () => {
      const perFlow = await Promise.all(
        flows.map((flow) =>
          layeredPositions(
            flow.steps.map((s) => ({ id: s.id, deps: s.dependsOn, width: STEP_WIDTH, height: estimateStepHeight(s) })),
            { width: STEP_WIDTH },
          ).then((pos) => ({ flow, pos })),
        ),
      );
      if (!alive) return;
      const labelByFlow = new Map<string, Node>();
      const stepBase = new Map<string, XY>();
      let yOffset = 0;
      for (const { flow, pos } of perFlow) {
        const ys = [...pos.values()].map((p) => p.y);
        const minY = ys.length ? Math.min(...ys) : 0;
        const maxY = ys.length ? Math.max(...ys) : 0;
        labelByFlow.set(flow.id, {
          id: `label:${flow.id}`,
          type: "flowLabel",
          position: { x: -200, y: yOffset },
          data: { label: flow.workflowId, tags: flow.tags },
          draggable: false,
          selectable: false,
        });
        for (const s of flow.steps) {
          const p = pos.get(s.id) ?? FALLBACK_POS;
          stepBase.set(s.id, { x: p.x, y: p.y - minY + yOffset });
        }
        yOffset += maxY - minY + 260;
      }
      setLayout({ labelByFlow, stepBase });
    })();
    return () => {
      alive = false;
    };
  }, [flows]);

  // Edges depend on the flow structure and the highlight state, not on positions, so
  // they stay referentially stable across a drag (React Flow re-routes them itself).
  const edges = useMemo(() => {
    const edges: Edge[] = [];
    for (const flow of flows) {
      for (const s of flow.steps) {
        for (const dep of s.dependsOn) {
          const active = related.steps.has(dep) && related.steps.has(s.id);
          edges.push({
            id: `${dep}~>${s.id}`,
            source: dep,
            target: s.id,
            sourceHandle: "out",
            targetHandle: "in",
            type: "smoothstep",
            markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
            style: { strokeWidth: active ? 2 : 1.25, opacity: related.steps.size > 0 && !active ? 0.15 : 1 },
          });
        }
        for (const b of s.branches) {
          if (!b.stepId) continue;
          const targetId = `${s.workflowId}::${b.stepId}`;
          edges.push({
            id: `${s.id}~${b.on}~>${targetId}`,
            source: s.id,
            target: targetId,
            sourceHandle: "out",
            targetHandle: "in",
            type: "smoothstep",
            animated: true,
            label: `${b.on}${b.criteria ? ` · ${b.criteria}` : ""}`,
            labelStyle: { fontSize: 10, fontWeight: 600 },
            labelBgPadding: [4, 2] as [number, number],
            labelBgBorderRadius: 4,
            style: { strokeWidth: 1.25, strokeDasharray: "5 4", stroke: b.on === "failure" ? "var(--destructive)" : "#10b981" },
          });
        }
      }
    }
    return edges;
  }, [flows, related]);

  // Build nodes preserving object identity for unchanged steps (see entities-tab):
  // dragging one step only changes its position, so only it is rebuilt — the rest of
  // the graph keeps its references and doesn't re-render.
  const nodeCache = useRef(new Map<string, { node: Node; sig: readonly unknown[] }>());
  const targetNodes = useMemo(() => {
    const cache = nodeCache.current;
    const live = new Set<string>();
    const out: Node[] = [];
    for (const flow of flows) {
      const label = layout.labelByFlow.get(flow.id);
      if (label) {
        out.push(label); // already stable (rebuilt only when `flows` changes)
        live.add(label.id);
      }
      for (const s of flow.steps) {
        live.add(s.id);
        const position = stepPositions[s.id] ?? layout.stepBase.get(s.id) ?? FALLBACK_POS;
        const resolvedOp = !s.operationId || !!index.endpointForStep(s);
        const dim = related.steps.size > 0 && !related.steps.has(s.id);
        const isErr = errored.has(s.id);
        const selected = selection?.kind === "step" && selection.id === s.id;
        const sig: readonly unknown[] = [s, position, resolvedOp, dim, isErr, selected, onSelect];
        const prev = cache.get(s.id);
        if (prev && prev.sig.every((v, i) => v === sig[i])) {
          out.push(prev.node);
          continue;
        }
        const node: Node = {
          id: s.id,
          type: "step",
          position,
          data: {
            step: s,
            resolvedOp,
            dim,
            errored: isErr,
            onPick: (id: string) => onSelect({ kind: "step", id }),
          } satisfies StepNodeData,
          selected,
        };
        cache.set(s.id, { node, sig });
        out.push(node);
      }
    }
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
    return out;
  }, [layout, flows, stepPositions, index, related, errored, selection, onSelect]);

  // React Flow owns positions during a drag; we only commit to the layout store on drag
  // stop (same approach as the ER tab). Re-deriving the nodes array from the store every
  // drag frame handed React Flow a fresh object for the node it was moving, which lost
  // its measured size and flashed.
  const [nodes, setNodes, onNodesChange] = useNodesState(targetNodes);
  const dragging = useRef(false);
  useEffect(() => {
    if (dragging.current) return; // never clobber the step being moved mid-drag
    setNodes(targetNodes);
  }, [targetNodes, setNodes]);

  const handleDragStart = useCallback(() => {
    dragging.current = true;
    onNodeDragStart();
  }, []);
  const handleDragStop = useCallback(
    (_e: unknown, _node: Node, dragged: Node[]) => {
      dragging.current = false;
      onNodeDragStop();
      for (const n of dragged) onMoveStep(n.id, n.position);
    },
    [onMoveStep],
  );

  const resetLayout = useCallback(() => {
    onResetSteps();
    setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 40);
  }, [onResetSteps, fitView]);

  // Re-fit once positions resolve (layout is async) and on every re-flow.
  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 80);
    return () => clearTimeout(t);
  }, [layout, fitView]);

  if (!flows.length) {
    return (
      <div className="grid h-full place-items-center text-sm text-muted-foreground">
        {graph.flows.length ? "No workflows match the active tag filter." : "No Arazzo workflows found in this project."}
      </div>
    );
  }
  if (!layout.labelByFlow.size) {
    return (
      <div className="grid h-full place-items-center text-muted-foreground">
        <Icon name="refresh" size={20} className="animate-spin" />
      </div>
    );
  }
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStart={handleDragStart}
      onNodeDragStop={handleDragStop}
      onPaneClick={() => onSelect(null)}
      fitView
      minZoom={0.2}
      nodesDraggable
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
      <Controls showInteractive={false} />
      {hasStepOverrides && (
        <Panel position="top-right">
          <button
            onClick={resetLayout}
            title="Discard this view's manual step positions and re-run auto-layout"
            className="flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 text-[12px] font-medium shadow-sm transition hover:bg-accent"
          >
            <Icon name="grid" size={13} /> Auto-layout
          </button>
        </Panel>
      )}
    </ReactFlow>
  );
}

export function FlowsTab(props: FlowsTabProps) {
  return (
    <ReactFlowProvider>
      <Graph {...props} />
    </ReactFlowProvider>
  );
}
