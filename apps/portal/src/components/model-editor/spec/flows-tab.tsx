import { memo, useCallback, useEffect, useMemo } from "react";
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
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
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

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    let yOffset = 0;
    for (const flow of flows) {
      const pos = layeredPositions(flow.steps.map((s) => ({ id: s.id, deps: s.dependsOn })), { dx: 290, dy: 150 });
      const ys = [...pos.values()].map((p) => p.y);
      const minY = ys.length ? Math.min(...ys) : 0;
      const maxY = ys.length ? Math.max(...ys) : 0;
      nodes.push({
        id: `label:${flow.id}`,
        type: "flowLabel",
        position: { x: -200, y: yOffset },
        data: { label: flow.workflowId, tags: flow.tags },
        draggable: false,
        selectable: false,
      });
      for (const s of flow.steps) {
        const p = pos.get(s.id) ?? { x: 0, y: 0 };
        nodes.push({
          id: s.id,
          type: "step",
          position: stepPositions[s.id] ?? { x: p.x, y: p.y - minY + yOffset },
          data: {
            step: s,
            resolvedOp: !s.operationId || !!index.endpointForStep(s),
            dim: related.steps.size > 0 && !related.steps.has(s.id),
            errored: errored.has(s.id),
            onPick: (id: string) => onSelect({ kind: "step", id }),
          } satisfies StepNodeData,
          selected: selection?.kind === "step" && selection.id === s.id,
        });
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
      yOffset += maxY - minY + 260;
    }
    return { nodes, edges };
  }, [flows, index, related, errored, selection, onSelect, stepPositions]);

  // Drags are reported up to the shell, which stages them (same loop as the ER tab).
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      for (const c of changes) if (c.type === "position" && c.position) onMoveStep(c.id, c.position);
    },
    [onMoveStep],
  );

  const resetLayout = useCallback(() => {
    onResetSteps();
    setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 40);
  }, [onResetSteps, fitView]);

  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 80);
    return () => clearTimeout(t);
  }, [flows, fitView]);

  if (!flows.length) {
    return (
      <div className="grid h-full place-items-center text-sm text-muted-foreground">
        {graph.flows.length ? "No workflows match the active tag filter." : "No Arazzo workflows found in this project."}
      </div>
    );
  }
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
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
