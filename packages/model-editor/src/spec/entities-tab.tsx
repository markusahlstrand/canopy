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
import { ACCENTS, ACCENT_KEYS, type AccentKey } from "../types";
import { layeredPositions, type XY } from "./layout";
import type { SpecModel } from "./graph-types";
import type { SpecViewProps } from "./view-types";

/** The Entities tab is layout-controlled by the shell (so views + commit live there). */
export interface EntitiesTabProps extends SpecViewProps {
  /** Positions for the active view, by model id. Missing ⇒ auto-layout. */
  positions: Record<string, XY>;
  onMove: (id: string, xy: XY) => void;
  onResetLayout: () => void;
  hasOverrides: boolean;
  /** Include transient DTO models (request/response payloads), not just entities. */
  showDtos: boolean;
  /** Active tag include-filter (empty ⇒ show all). */
  tagFilter: string[];
}

interface EntityNodeData extends Record<string, unknown> {
  model: SpecModel;
  color: AccentKey;
  dim: boolean;
  errored: boolean;
  isDto: boolean;
  onPick: (id: string) => void;
}

function SpecEntityNodeImpl({ data, selected }: NodeProps) {
  const d = data as EntityNodeData;
  const accent = ACCENTS[d.color];
  const m = d.model;
  return (
    <div
      onClick={() => d.onPick(m.id)}
      className={cn(
        "w-[230px] cursor-pointer overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm transition",
        d.dim && "opacity-30",
        // DTOs are wire shapes, not stored records — dash the border + lighten the card
        // so they read as "passing through" next to the solid entities.
        d.isDto && "border-dashed bg-muted/30",
      )}
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
        {d.isDto && m.kind !== "enum" && <span className="rounded bg-muted px-1 py-0.5 font-mono text-[9px] text-muted-foreground">dto</span>}
      </div>
      {!!m.tags?.length && (
        <div className="flex flex-wrap gap-1 border-b px-3 py-1.5">
          {m.tags.map((t) => (
            <span key={t} className="rounded-full bg-accent px-1.5 py-0.5 font-mono text-[9px] text-accent-foreground">#{t}</span>
          ))}
        </div>
      )}
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

// Shared fallback position (stable identity) for entities without a placed/auto position.
const FALLBACK_POS = { x: 0, y: 0 };

/** Card width is fixed by `w-[230px]`. */
const ENTITY_WIDTH = 230;
// Rough card height so dagre can pack ranks without overlap. We round each part up:
// over-estimating only adds breathing room, while under-estimating brings overlap back.
function estimateEntityHeight(m: SpecModel): number {
  const header = 40;
  const tags = m.tags?.length ? 30 : 0;
  const body =
    m.kind === "enum"
      ? 20 + Math.ceil((m.enumValues?.length ?? 0) / 3) * 28
      : Math.max(1, m.fields.length) * 30;
  return header + tags + body;
}

function Graph({ graph, selection, related, onSelect, positions, onMove, onResetLayout, hasOverrides, showDtos, tagFilter }: EntitiesTabProps) {
  const { fitView } = useReactFlow();
  // Entities are the default view; DTOs (request/response payloads) are opt-in so the
  // canvas reads as a data model, not a wire-format dump. An active tag filter then
  // narrows to models carrying at least one selected tag.
  const models = useMemo(() => {
    const base = showDtos ? graph.models : graph.models.filter((m) => m.role !== "dto");
    return tagFilter.length ? base.filter((m) => m.tags?.some((t) => tagFilter.includes(t))) : base;
  }, [graph.models, showDtos, tagFilter]);
  const visibleIds = useMemo(() => new Set(models.map((m) => m.id)), [models]);
  const errored = useMemo(
    () => new Set(graph.diagnostics.filter((d) => d.target?.kind === "entity").map((d) => d.target!.id)),
    [graph.diagnostics],
  );
  const colorFor = useMemo(() => {
    const map = new Map<string, AccentKey>();
    models.forEach((m, i) => map.set(m.id, ACCENT_KEYS[i % ACCENT_KEYS.length]!));
    return map;
  }, [models]);

  // Auto-layout gives the default arrangement; the active view's saved positions
  // override it per model. Drags are reported up to the shell, which stages them.
  //
  // Direction matters: edges are drawn source = the model holding the FK → target =
  // the referenced model (arrowhead on the referenced one, out the right handle into
  // the next card's left handle). For those to flow forward, the *referencing* model
  // must sit to the LEFT of the one it points at. `layeredPositions` places an item's
  // `deps` to its left, so we feed it reverse adjacency: a referenced model lists the
  // models that point at it as its upstream deps. Only edges between visible nodes
  // count, so hiding DTOs doesn't strand entities.
  const layoutItems = useMemo(() => {
    const upstream = new Map<string, string[]>(models.map((m) => [m.id, []]));
    for (const m of models)
      for (const f of m.fields)
        if (f.ref && f.ref !== m.id && visibleIds.has(f.ref)) upstream.get(f.ref)!.push(m.id);
    return models.map((m) => ({
      id: m.id,
      deps: upstream.get(m.id)!,
      width: ENTITY_WIDTH,
      height: estimateEntityHeight(m),
    }));
  }, [models, visibleIds]);
  // ELK is async, so compute into state. We keep the previous result while a new one
  // is in flight (rather than clearing it) so a filter toggle re-flows without a flash.
  const [layout, setLayout] = useState<Map<string, XY>>(new Map());
  useEffect(() => {
    let alive = true;
    layeredPositions(layoutItems, { width: ENTITY_WIDTH }).then((pos) => alive && setLayout(pos));
    return () => {
      alive = false;
    };
  }, [layoutItems]);

  const resetLayout = useCallback(() => {
    onResetLayout();
    setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 40);
  }, [onResetLayout, fitView]);

  // Build nodes while preserving object identity for unchanged entities: React Flow
  // re-renders a node whenever its object reference changes, so rebuilding every node
  // each render (e.g. on a single drag) would re-render the whole graph and flicker at
  // scale. Reuse the prior node object whenever its inputs are referentially identical
  // — only the dragged entity's position changes, so only it is rebuilt.
  const nodeCache = useRef(new Map<string, { node: Node; sig: readonly unknown[] }>());
  const targetNodes: Node[] = useMemo(() => {
    const cache = nodeCache.current;
    const live = new Set<string>();
    const out = models.map((m) => {
      live.add(m.id);
      const position = positions[m.id] ?? layout.get(m.id) ?? FALLBACK_POS;
      const color = colorFor.get(m.id) ?? "zinc";
      const dim = related.entities.size > 0 && !related.entities.has(m.id);
      const isErr = errored.has(m.id);
      const isDto = m.role === "dto";
      const selected = selection?.kind === "entity" && selection.id === m.id;
      const sig: readonly unknown[] = [m, position, color, dim, isErr, isDto, selected, onSelect];
      const prev = cache.get(m.id);
      if (prev && prev.sig.every((v, i) => v === sig[i])) return prev.node;
      const node: Node = {
        id: m.id,
        type: "specEntity",
        position,
        data: { model: m, color, dim, errored: isErr, isDto, onPick: (id: string) => onSelect({ kind: "entity", id }) } satisfies EntityNodeData,
        selected,
      };
      cache.set(m.id, { node, sig });
      return node;
    });
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
    return out;
  }, [models, layout, positions, colorFor, related, errored, selection, onSelect]);

  // React Flow owns node positions during a drag. We mirror `targetNodes` into its
  // state and let `onNodesChange` apply drag deltas, committing the final position to
  // the layout store only on drag stop. Re-deriving the nodes array from the store on
  // every drag frame (the previous approach) handed React Flow a fresh object for the
  // node it was dragging each frame, so it lost its measured size and flashed.
  const [nodes, setNodes, onNodesChange] = useNodesState(targetNodes);
  const dragging = useRef(false);
  useEffect(() => {
    if (dragging.current) return; // never clobber the node being moved mid-drag
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
      for (const n of dragged) onMove(n.id, n.position);
    },
    [onMove],
  );

  const edges: Edge[] = useMemo(() => {
    const seen = new Set<string>();
    const out: Edge[] = [];
    for (const m of models) {
      for (const f of m.fields) {
        if (!f.ref || f.ref === m.id || !visibleIds.has(f.ref)) continue;
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
  }, [models, visibleIds, related]);

  // Re-fit once positions resolve (layout is async) and on every re-flow.
  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 80);
    return () => clearTimeout(t);
  }, [layout, fitView]);

  if (!models.length) {
    return (
      <div className="grid h-full place-items-center text-sm text-muted-foreground">
        {graph.models.length ? "No entities — every model here is a request/response DTO. Toggle “Show DTOs”." : "No TypeSpec models found in this project."}
      </div>
    );
  }
  if (!layout.size) {
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
      {hasOverrides && (
        <Panel position="top-right">
          <button
            onClick={resetLayout}
            title="Discard this view's manual positions and re-run auto-layout"
            className="flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 text-[12px] font-medium shadow-sm transition hover:bg-accent"
          >
            <Icon name="grid" size={13} /> Auto-layout
          </button>
        </Panel>
      )}
    </ReactFlow>
  );
}

export function EntitiesTab(props: EntitiesTabProps) {
  return (
    <ReactFlowProvider>
      <Graph {...props} />
    </ReactFlowProvider>
  );
}
