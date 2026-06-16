import { memo, useEffect, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { cn } from "@/lib/utils";
import { ACCENTS, ACCENT_KEYS, type AccentKey } from "../types";
import { layeredPositions } from "./layout";
import type { SpecModel } from "./graph-types";
import type { SpecViewProps } from "./view-types";

interface EntityNodeData extends Record<string, unknown> {
  model: SpecModel;
  color: AccentKey;
  dim: boolean;
  errored: boolean;
  onPick: (id: string) => void;
}

function SpecEntityNodeImpl({ data, selected }: NodeProps) {
  const d = data as EntityNodeData;
  const accent = ACCENTS[d.color];
  const m = d.model;
  return (
    <div
      onClick={() => d.onPick(m.id)}
      className={cn("w-[230px] cursor-pointer overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm transition", d.dim && "opacity-30")}
      style={{
        borderColor: d.errored ? "var(--destructive)" : selected ? accent.dot : "var(--border)",
        boxShadow: selected ? `0 0 0 2px ${accent.ring}` : undefined,
      }}
    >
      <Handle id="in" type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-2 !border-background" style={{ background: accent.dot }} />
      <Handle id="out" type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-background" style={{ background: accent.dot }} />
      <div className="flex items-center gap-2 px-3 py-2" style={{ background: accent.soft, borderBottom: "1px solid var(--border)" }}>
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: accent.dot }} />
        <span className="truncate text-[13px] font-semibold tracking-tight">{m.name}</span>
        {m.isError && <span className="rounded bg-destructive/10 px-1 py-0.5 font-mono text-[9px] text-destructive">error</span>}
        {m.kind === "enum" && <span className="rounded bg-muted px-1 py-0.5 font-mono text-[9px] text-muted-foreground">enum</span>}
      </div>
      {m.kind === "enum" ? (
        <div className="flex flex-wrap gap-1 px-3 py-2">
          {(m.enumValues ?? []).map((v) => <span key={v} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{v}</span>)}
        </div>
      ) : (
        <ul className="divide-y">
          {m.fields.map((f) => (
            <li key={f.name} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
              {f.key ? <span className="font-mono text-[9px] text-amber-500">KEY</span> : f.ref ? <span className="font-mono text-[9px] text-sky-500">FK</span> : <span className="w-[18px]" />}
              <span className="truncate font-medium">{f.name}</span>
              {!f.optional && <span className="text-rose-400">*</span>}
              <span className="ml-auto shrink-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{f.type}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
const SpecEntityNode = memo(SpecEntityNodeImpl);
const nodeTypes = { specEntity: SpecEntityNode };

function Graph({ graph, selection, related, onSelect }: SpecViewProps) {
  const { fitView } = useReactFlow();
  const errored = useMemo(
    () => new Set(graph.diagnostics.filter((d) => d.target?.kind === "entity").map((d) => d.target!.id)),
    [graph.diagnostics],
  );
  const colorFor = useMemo(() => {
    const map = new Map<string, AccentKey>();
    graph.models.forEach((m, i) => map.set(m.id, ACCENT_KEYS[i % ACCENT_KEYS.length]!));
    return map;
  }, [graph.models]);

  const positions = useMemo(
    () => layeredPositions(graph.models.map((m) => ({ id: m.id, deps: m.fields.map((f) => f.ref).filter((r): r is string => !!r) })), { dx: 300, dy: 200 }),
    [graph.models],
  );

  const nodes: Node[] = useMemo(
    () =>
      graph.models.map((m) => ({
        id: m.id,
        type: "specEntity",
        position: positions.get(m.id) ?? { x: 0, y: 0 },
        data: {
          model: m,
          color: colorFor.get(m.id) ?? "zinc",
          dim: related.entities.size > 0 && !related.entities.has(m.id),
          errored: errored.has(m.id),
          onPick: (id: string) => onSelect({ kind: "entity", id }),
        } satisfies EntityNodeData,
        selected: selection?.kind === "entity" && selection.id === m.id,
      })),
    [graph.models, positions, colorFor, related, errored, selection, onSelect],
  );

  const edges: Edge[] = useMemo(() => {
    const seen = new Set<string>();
    const out: Edge[] = [];
    for (const m of graph.models) {
      for (const f of m.fields) {
        if (!f.ref || f.ref === m.id) continue;
        const id = `${m.id}->${f.ref}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const active = related.entities.has(m.id) && related.entities.has(f.ref);
        out.push({
          id,
          source: m.id,
          target: f.ref,
          sourceHandle: "out",
          targetHandle: "in",
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
          style: { strokeWidth: active ? 2 : 1.25, opacity: related.entities.size > 0 && !active ? 0.15 : 1 },
        });
      }
    }
    return out;
  }, [graph.models, related]);

  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 80);
    return () => clearTimeout(t);
  }, [graph.models, fitView]);

  if (!graph.models.length) {
    return <div className="grid h-full place-items-center text-sm text-muted-foreground">No TypeSpec models found in this project.</div>;
  }
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onPaneClick={() => onSelect(null)}
      fitView
      minZoom={0.2}
      nodesDraggable
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

export function EntitiesTab(props: SpecViewProps) {
  return (
    <ReactFlowProvider>
      <Graph {...props} />
    </ReactFlowProvider>
  );
}
