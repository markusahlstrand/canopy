import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./model-editor.css";
import { onNodeDragStart, onNodeDragStop } from "./node-drag-cursor";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Tabs,
  TabsList,
  TabsTrigger,
  Icon,
  cn,
  toast,
} from "@canopy/ui";
import { EntityNode, type EntityNodeData } from "./entity-node";
import { AssistantPanel } from "./assistant-panel";
import { ExportPanel } from "./export-panel";
import { Inspector } from "./inspector";
import { toPrisma } from "./export";
import { coerceModel, layout } from "./model-io";
import { fromPrisma } from "./prisma-parse";
import { loadLibrary, saveLibrary, type StoredModel } from "./storage";
import { useOptionalPluginHost, usePluginTheme } from "@canopy/plugin-sdk";
import {
  ACCENTS,
  ACCENT_KEYS,
  uid,
  type AccentKey,
  type Cardinality,
  type DomainModel,
  type Property,
  type Relation,
  type RelationData,
} from "./types";

const nodeTypes = { entity: EntityNode };

const CARD_SYMBOL: Record<Cardinality, string> = {
  "1-1": "1:1",
  "1-N": "1:N",
  "N-1": "N:1",
  "N-M": "N:M",
};

const defaultEdgeOptions = {
  type: "smoothstep",
  markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
  style: { strokeWidth: 1.5 },
};

// Hoisted so their identity is stable across renders — passing fresh array/object
// literals here makes React Flow re-process them on every drag frame (flicker).
const deleteKeyCodes = ["Backspace", "Delete"];
const proOptions = { hideAttribution: true };
const miniMapNodeColor = (n: Node) => ACCENTS[(n.data as EntityNodeData).color ?? "zinc"].dot;

type Selection = { type: "entity" | "relation"; id: string } | null;
type RightTab = "assistant" | "inspector" | "export";

const data = (n: Node): EntityNodeData => n.data as EntityNodeData;

function edgeLabel(r: RelationData): string {
  return `${r.name ? r.name + " · " : ""}${CARD_SYMBOL[r.cardinality]}`;
}

function relationToEdge(r: Relation): Edge {
  return {
    id: r.id,
    source: r.fromEntityId,
    target: r.toEntityId,
    sourceHandle: "out",
    targetHandle: "in",
    label: edgeLabel(r),
    data: { name: r.name, cardinality: r.cardinality, fromLabel: r.fromLabel, toLabel: r.toLabel },
    labelStyle: { fontSize: 11, fontWeight: 600 },
    labelBgPadding: [6, 3] as [number, number],
    labelBgBorderRadius: 6,
  };
}

function modelToFlow(model: DomainModel): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: model.entities.map((e) => ({
      id: e.id,
      type: "entity",
      position: e.position,
      data: { name: e.name, description: e.description, properties: e.properties, color: e.color },
    })),
    edges: model.relations.map(relationToEdge),
  };
}

function flowToModel(nodes: Node[], edges: Edge[], name: string): DomainModel {
  return {
    name,
    version: 1,
    entities: nodes.map((n) => {
      const d = data(n);
      return {
        id: n.id,
        name: d.name,
        description: d.description,
        color: d.color,
        position: n.position,
        properties: d.properties,
      };
    }),
    relations: edges.map((e) => {
      const d = (e.data ?? {}) as Partial<RelationData>;
      return {
        id: e.id,
        name: d.name,
        fromEntityId: e.source,
        toEntityId: e.target,
        cardinality: d.cardinality ?? "1-N",
        fromLabel: d.fromLabel,
        toLabel: d.toLabel,
      } satisfies Relation;
    }),
  };
}

const emptyModel = (): DomainModel => ({ name: "Untitled model", version: 1, entities: [], relations: [] });

// A single stable model reference handed to the (memoised) ExportPanel while it's
// hidden, so dragging nodes never re-renders it; the live model flows in only when
// the Export tab is active.
const EXPORT_IDLE_MODEL = emptyModel();

/** Load the saved library, seeding a blank model on first run. */
function bootstrap(): { models: StoredModel[]; current: StoredModel } {
  const lib = loadLibrary();
  if (lib.models.length) {
    const current = lib.models.find((m) => m.id === lib.currentId) ?? lib.models[0]!;
    return { models: lib.models, current };
  }
  const current: StoredModel = { id: uid("mdl"), model: emptyModel(), updatedAt: Date.now() };
  return { models: [current], current };
}

/** A .prisma file the editor is bound to (file-viewer mode). */
export interface FileBinding {
  name: string;
  content: string;
  onSave?: (prisma: string) => Promise<void> | void;
}

const baseName = (name: string) => name.replace(/\.[^.]+$/, "");

/** Parse a bound file's Prisma text into the canvas model (empty on parse failure). */
function fileBoot(file: FileBinding): DomainModel {
  let model: DomainModel;
  try {
    model = file.content.trim() ? fromPrisma(file.content) : emptyModel();
  } catch {
    model = emptyModel();
  }
  model.name = baseName(file.name);
  return model;
}

function Editor({ file }: { file?: FileBinding }) {
  const fileMode = !!file;
  // Host bridge — only present when mounted as a standalone view in the portal.
  // In file mode (a .prisma preview) we never offer "new document", so its absence
  // is fine. Lets the scratch canvas persist itself to the drive without the host
  // wiring a model-editor-specific callback.
  const host = useOptionalPluginHost();
  const boot = useMemo(() => (file ? null : bootstrap()), [file]);
  const initialModel = useMemo(
    () => (file ? fileBoot(file) : boot!.current.model),
    [file, boot],
  );
  const initial = useMemo(() => modelToFlow(initialModel), [initialModel]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [name, setName] = useState(initialModel.name);
  const [models, setModels] = useState<StoredModel[]>(boot?.models ?? []);
  const [currentId, setCurrentId] = useState(boot?.current.id ?? "file");
  const [selection, setSelection] = useState<Selection>(null);
  const [tab, setTab] = useState<RightTab>(fileMode ? "inspector" : "assistant");
  const [panelOpen, setPanelOpen] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // Whether to embed editor metadata as comments. "ask" prompts on each save
  // until the user picks a remembered answer for this document.
  const [metaPref, setMetaPref] = useState<"ask" | "embed" | "plain">("ask");
  const [saveDialog, setSaveDialog] = useState(false);
  const [rememberMeta, setRememberMeta] = useState(false);
  const savedOnce = useRef(false);
  const dirtyOnce = useRef(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const colorMode = usePluginTheme().dark ? "dark" : "light";
  const { screenToFlowPosition, fitView } = useReactFlow();

  const model = useMemo(() => flowToModel(nodes, edges, name), [nodes, edges, name]);

  // Mirror the live model/nodes in refs so callbacks can read the latest values
  // without listing them as deps. That keeps handlers passed to the side panels
  // stable across renders, so dragging a node (which churns `nodes` every frame)
  // re-renders only React Flow, not the whole editor tree.
  const modelRef = useRef(model);
  modelRef.current = model;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const getModel = useCallback(() => modelRef.current, []);

  // ── File mode: track unsaved changes; save serialises the canvas to Prisma ──
  useEffect(() => {
    if (!fileMode) return;
    if (!dirtyOnce.current) {
      dirtyOnce.current = true;
      return; // skip the initial load
    }
    setDirty(true);
  }, [model, fileMode]);

  const writeFile = useCallback(
    async (embed: boolean) => {
      if (!file?.onSave || saving) return;
      setSaving(true);
      try {
        await file.onSave(toPrisma(modelRef.current, { metadata: embed }));
        setDirty(false);
      } catch {
        toast.error("Couldn't save the file");
      } finally {
        setSaving(false);
      }
    },
    [file, saving],
  );

  const saveToFile = useCallback(() => {
    if (!file?.onSave || saving) return;
    if (metaPref === "ask") {
      setSaveDialog(true); // ask whether to embed metadata, then write
      return;
    }
    void writeFile(metaPref === "embed");
  }, [file, saving, metaPref, writeFile]);

  useEffect(() => {
    if (!fileMode) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveToFile();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fileMode, saveToFile]);

  // ── Persistence: debounced autosave of the current model to localStorage ──
  useEffect(() => {
    if (fileMode) return; // file mode persists to the file, not the local library
    // Skip the very first run so opening the editor doesn't bump updatedAt.
    if (!savedOnce.current) {
      savedOnce.current = true;
      return;
    }
    const t = setTimeout(() => {
      const entry: StoredModel = { id: currentId, model, updatedAt: Date.now() };
      setModels((prev) => {
        const next = prev.some((m) => m.id === currentId)
          ? prev.map((m) => (m.id === currentId ? entry : m))
          : [...prev, entry];
        saveLibrary({ models: next, currentId });
        return next;
      });
    }, 400);
    return () => clearTimeout(t);
  }, [model, currentId]);

  /** Merge the live canvas back into the library list (flush before switching). */
  const flushCurrent = useCallback(
    (list: StoredModel[]): StoredModel[] => {
      const entry: StoredModel = { id: currentId, model, updatedAt: Date.now() };
      return list.some((m) => m.id === currentId)
        ? list.map((m) => (m.id === currentId ? entry : m))
        : [...list, entry];
    },
    [currentId, model],
  );

  const loadInto = useCallback(
    (m: DomainModel) => {
      const flow = modelToFlow(m);
      setNodes(flow.nodes);
      setEdges(flow.edges);
      setName(m.name);
      setSelection(null);
      setTimeout(() => fitView({ padding: 0.2, duration: 400 }), 60);
    },
    [setNodes, setEdges, fitView],
  );

  const switchModel = useCallback(
    (id: string) => {
      if (id === currentId) return;
      const merged = flushCurrent(models);
      const target = merged.find((m) => m.id === id);
      if (!target) return;
      setModels(merged);
      setCurrentId(id);
      saveLibrary({ models: merged, currentId: id });
      loadInto(target.model);
    },
    [currentId, models, flushCurrent, loadInto],
  );

  const newModel = useCallback(() => {
    const fresh: StoredModel = { id: uid("mdl"), model: emptyModel(), updatedAt: Date.now() };
    const merged = [...flushCurrent(models), fresh];
    setModels(merged);
    setCurrentId(fresh.id);
    saveLibrary({ models: merged, currentId: fresh.id });
    loadInto(fresh.model);
  }, [models, flushCurrent, loadInto]);

  const duplicateModel = useCallback(() => {
    const copy: StoredModel = {
      id: uid("mdl"),
      model: { ...model, name: `${model.name} copy` },
      updatedAt: Date.now(),
    };
    const merged = [...flushCurrent(models), copy];
    setModels(merged);
    setCurrentId(copy.id);
    saveLibrary({ models: merged, currentId: copy.id });
    setName(copy.model.name);
  }, [model, models, flushCurrent]);

  // Persist the current scratch canvas to a real .prisma file in the drive and open
  // it in file mode. Routed through the generic host bridge — no host-side callback.
  const newDocument = useCallback(async () => {
    if (!host) return;
    if (!host.online) {
      toast.error("You can't create documents while offline");
      return;
    }
    const input = window.prompt("New Prisma document name", name || "schema");
    if (!input?.trim()) return;
    const base = input.trim();
    const fileName = base.toLowerCase().endsWith(".prisma") ? base : `${base}.prisma`;
    await host.createAndOpenFile({
      name: fileName,
      content: toPrisma(model, { metadata: false }),
      mime: "text/x-prisma",
    });
  }, [host, model, name]);

  const deleteModel = useCallback(
    (id: string) => {
      const remaining = models.filter((m) => m.id !== id);
      if (id !== currentId) {
        setModels(remaining);
        saveLibrary({ models: remaining, currentId });
        return;
      }
      // Deleting the open model: fall back to another, or reseed an empty one.
      const fallback = remaining[0] ?? { id: uid("mdl"), model: emptyModel(), updatedAt: Date.now() };
      const next = remaining.length ? remaining : [fallback];
      setModels(next);
      setCurrentId(fallback.id);
      saveLibrary({ models: next, currentId: fallback.id });
      loadInto(fallback.model);
    },
    [models, currentId, loadInto],
  );

  // ── Entity mutations ──
  const patchNode = useCallback(
    (id: string, fn: (d: EntityNodeData) => EntityNodeData) => {
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: fn(data(n)) } : n)));
    },
    [setNodes],
  );

  const updateEntity = useCallback(
    (id: string, patch: Partial<EntityNodeData>) => patchNode(id, (d) => ({ ...d, ...patch })),
    [patchNode],
  );

  const updateProperty = useCallback(
    (entityId: string, propId: string, patch: Partial<Property>) =>
      patchNode(entityId, (d) => ({
        ...d,
        properties: d.properties.map((p) => (p.id === propId ? { ...p, ...patch } : p)),
      })),
    [patchNode],
  );

  const addProperty = useCallback(
    (entityId: string) =>
      patchNode(entityId, (d) => ({
        ...d,
        properties: [...d.properties, { id: uid("prop"), name: "field", type: "string" }],
      })),
    [patchNode],
  );

  const removeProperty = useCallback(
    (entityId: string, propId: string) =>
      patchNode(entityId, (d) => ({ ...d, properties: d.properties.filter((p) => p.id !== propId) })),
    [patchNode],
  );

  const moveProperty = useCallback(
    (entityId: string, propId: string, dir: -1 | 1) =>
      patchNode(entityId, (d) => {
        const i = d.properties.findIndex((p) => p.id === propId);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= d.properties.length) return d;
        const next = [...d.properties];
        [next[i], next[j]] = [next[j]!, next[i]!];
        return { ...d, properties: next };
      }),
    [patchNode],
  );

  const deleteEntity = useCallback(
    (id: string) => {
      setNodes((ns) => ns.filter((n) => n.id !== id));
      setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
      setSelection(null);
    },
    [setNodes, setEdges],
  );

  const addEntity = useCallback(
    (position?: { x: number; y: number }) => {
      const id = uid("ent");
      const color = ACCENT_KEYS[nodes.length % ACCENT_KEYS.length] as AccentKey;
      const node: Node = {
        id,
        type: "entity",
        position: position ?? { x: 120, y: 120 },
        data: {
          name: "NewEntity",
          properties: [{ id: uid("prop"), name: "id", type: "uuid", primaryKey: true, required: true }],
          color,
        } satisfies EntityNodeData,
      };
      setNodes((ns) => [...ns, node]);
      setSelection({ type: "entity", id });
      setTab("inspector");
      setPanelOpen(true);
    },
    [nodes.length, setNodes],
  );

  // ── Relation mutations ──
  const onConnect = useCallback(
    (c: Connection) => {
      const rel: Relation = {
        id: uid("rel"),
        fromEntityId: c.source!,
        toEntityId: c.target!,
        cardinality: "1-N",
      };
      setEdges((es) => addEdge(relationToEdge(rel), es));
    },
    [setEdges],
  );

  const updateRelation = useCallback(
    (id: string, patch: Partial<RelationData>) => {
      setEdges((es) =>
        es.map((e) => {
          if (e.id !== id) return e;
          const nextData = { ...(e.data as Partial<RelationData>), ...patch } as RelationData;
          return { ...e, data: nextData, label: edgeLabel(nextData) };
        }),
      );
    },
    [setEdges],
  );

  const swapRelation = useCallback(
    (id: string) => {
      setEdges((es) =>
        es.map((e) => {
          if (e.id !== id) return e;
          const d = (e.data ?? {}) as Partial<RelationData>;
          const flip: Record<Cardinality, Cardinality> = {
            "1-1": "1-1",
            "N-M": "N-M",
            "1-N": "N-1",
            "N-1": "1-N",
          };
          const nextData: RelationData = {
            ...d,
            cardinality: flip[d.cardinality ?? "1-N"],
            fromLabel: d.toLabel,
            toLabel: d.fromLabel,
          } as RelationData;
          return {
            ...e,
            source: e.target,
            target: e.source,
            data: nextData,
            label: edgeLabel(nextData),
          };
        }),
      );
    },
    [setEdges],
  );

  const deleteRelation = useCallback(
    (id: string) => {
      setEdges((es) => es.filter((e) => e.id !== id));
      setSelection(null);
    },
    [setEdges],
  );

  // ── Apply a model proposal (from the assistant or an import) ──
  const applyModel = useCallback(
    (raw: unknown, opts: { layoutFresh?: boolean } = {}) => {
      let parsed: DomainModel;
      try {
        parsed = coerceModel(raw, { layout: false });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not read model");
        return;
      }
      // Keep manual positions for entities that still exist (matched by name).
      const prevPos = new Map(nodesRef.current.map((n) => [data(n).name.toLowerCase(), n.position]));
      if (!opts.layoutFresh) {
        for (const e of parsed.entities) {
          const p = prevPos.get(e.name.toLowerCase());
          if (p) e.position = p;
        }
      }
      const needLayout = opts.layoutFresh || parsed.entities.every((e) => !prevPos.has(e.name.toLowerCase()));
      if (needLayout) layout(parsed);
      const flow = modelToFlow(parsed);
      setNodes(flow.nodes);
      setEdges(flow.edges);
      setName(parsed.name);
      setSelection(null);
      setTimeout(() => fitView({ padding: 0.2, duration: 400 }), 60);
    },
    [setNodes, setEdges, fitView],
  );

  // ── Toolbar actions ──
  const autoLayout = useCallback(() => {
    const m = flowToModel(nodes, edges, name);
    layout(m);
    const pos = new Map(m.entities.map((e) => [e.id, e.position]));
    setNodes((ns) => ns.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })));
    setTimeout(() => fitView({ padding: 0.2, duration: 400 }), 60);
  }, [nodes, edges, name, setNodes, fitView]);

  const importFile = useCallback(
    (file: File) => {
      void file.text().then((txt) => {
        try {
          applyModel(JSON.parse(txt));
          toast.success("Model imported");
        } catch {
          toast.error("Invalid JSON file");
        }
      });
    },
    [applyModel],
  );

  // ── Drag & drop a new entity from the toolbar chip ──
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/canopy-entity")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("application/canopy-entity")) return;
      e.preventDefault();
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addEntity(pos);
    },
    [screenToFlowPosition, addEntity],
  );

  // ── Derived inspector inputs ──
  // Memoised on the data that the inspector actually shows — entity/relation
  // identity, names, properties — but NOT on node positions, so dragging a node
  // (which replaces the node object every frame) doesn't re-render the inspector.
  const selectedNode = selection?.type === "entity" ? nodes.find((x) => x.id === selection.id) ?? null : null;
  const selectedNodeData = selectedNode ? data(selectedNode) : null;
  const selectedEntity = useMemo(
    () => (selectedNode ? { id: selectedNode.id, data: selectedNodeData! } : null),
    [selectedNode?.id, selectedNodeData],
  );

  const selectedEdge = selection?.type === "relation" ? edges.find((x) => x.id === selection.id) ?? null : null;
  const fromNode = selectedEdge ? nodes.find((n) => n.id === selectedEdge.source) : undefined;
  const toNode = selectedEdge ? nodes.find((n) => n.id === selectedEdge.target) : undefined;
  const fromName = fromNode ? data(fromNode).name : "?";
  const toName = toNode ? data(toNode).name : "?";
  const selectedRelation = useMemo(
    () =>
      selectedEdge
        ? { id: selectedEdge.id, data: (selectedEdge.data ?? { cardinality: "1-N" }) as RelationData, fromName, toName }
        : null,
    [selectedEdge?.id, selectedEdge?.data, fromName, toName],
  );

  // Stable across position-only changes: only the id/name pairs matter here.
  const entitySig = nodes.map((n) => `${n.id}:${data(n).name}`).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- entitySig captures the relevant content of `nodes`
  const entityList = useMemo(() => nodes.map((n) => ({ id: n.id, name: data(n).name })), [entitySig]);

  // Stable canvas handlers — inline arrows here would change identity every drag
  // frame and force React Flow to re-render the whole canvas (flicker).
  const onNodeClick = useCallback((_: unknown, n: Node) => {
    setSelection({ type: "entity", id: n.id });
    setTab("inspector");
    setPanelOpen(true);
  }, []);
  const onEdgeClick = useCallback((_: unknown, e: Edge) => {
    setSelection({ type: "relation", id: e.id });
    setTab("inspector");
    setPanelOpen(true);
  }, []);
  const onPaneClick = useCallback(() => setSelection(null), []);

  return (
    <div className="flex h-full w-full flex-col bg-background">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <Icon name="model" size={18} className="shrink-0 text-primary" />
        {fileMode ? (
          <>
            <span className="max-w-[200px] truncate font-mono text-[13px] font-semibold" title={file!.name}>
              {file!.name}
            </span>
            <Button
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => void saveToFile()}
              disabled={saving || !dirty}
              title="Save to file (⌘S)"
            >
              <Icon name={saving ? "refresh" : dirty ? "cloud" : "circle-check"} size={14} className={saving ? "animate-spin" : ""} />
              {saving ? "Saving…" : dirty ? "Save" : "Saved"}
            </Button>
          </>
        ) : (
          <>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-8 w-[160px] shrink-0 font-semibold"
              aria-label="Model name"
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon-sm" className="shrink-0" title="Saved models" aria-label="Saved models">
                  <Icon name="chevron-down" size={14} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-60">
                <DropdownMenuLabel>Saved models ({models.length})</DropdownMenuLabel>
                {models.map((m) => (
                  <DropdownMenuItem
                    key={m.id}
                    onClick={() => switchModel(m.id)}
                    className="group flex items-center gap-2"
                  >
                    <Icon
                      name="circle-check"
                      size={14}
                      className={cn(m.id === currentId ? "text-primary" : "opacity-0")}
                    />
                    <span className="flex-1 truncate">{m.model.name || "Untitled"}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {m.model.entities.length}
                    </span>
                    <button
                      className="opacity-0 transition group-hover:opacity-100 hover:text-destructive"
                      title="Delete model"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteModel(m.id);
                      }}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={newModel} className="gap-2">
                  <Icon name="plus" size={14} /> New model
                </DropdownMenuItem>
                <DropdownMenuItem onClick={duplicateModel} className="gap-2">
                  <Icon name="package" size={14} /> Duplicate current
                </DropdownMenuItem>
                {host && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => void newDocument()} className="gap-2">
                      <Icon name="file-text" size={14} /> New Prisma document…
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        <div className="mx-1 h-5 w-px bg-border" />
        <div
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("application/canopy-entity", "1");
            e.dataTransfer.effectAllowed = "copy";
          }}
          className="flex cursor-grab items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground active:cursor-grabbing hover:border-primary hover:text-foreground"
          title="Drag onto the canvas to create an entity"
        >
          <Icon name="plus" size={13} /> Drag entity
        </div>
        <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => addEntity()}>
          <Icon name="plus" size={14} /> Add entity
        </Button>
        <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={autoLayout}>
          <Icon name="grid" size={14} /> Auto-layout
        </Button>
        {!fileMode && (
          <>
            <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => fileRef.current?.click()}>
              <Icon name="upload" size={14} /> Import
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importFile(f);
                e.target.value = "";
              }}
            />
          </>
        )}
        <div className="ml-auto flex items-center gap-2 font-mono text-[12px] text-muted-foreground">
          <span>{nodes.length} entities</span>
          <span>·</span>
          <span>{edges.length} relations</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setPanelOpen((v) => !v)}
          title={panelOpen ? "Hide panel" : "Show panel"}
        >
          <Icon name={panelOpen ? "panel-right" : "panel-left"} size={16} />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Canvas */}
        <div ref={wrapperRef} className="relative min-w-0 flex-1" onDragOver={onDragOver} onDrop={onDrop}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            defaultEdgeOptions={defaultEdgeOptions}
            colorMode={colorMode}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onPaneClick={onPaneClick}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            deleteKeyCode={deleteKeyCodes}
            fitView
            minZoom={0.2}
            proOptions={proOptions}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              nodeColor={miniMapNodeColor}
              className="!bg-card"
            />
          </ReactFlow>
        </div>

        {/* Right panel */}
        {panelOpen && (
          <div className="flex w-[360px] shrink-0 flex-col border-l bg-background">
            <Tabs value={tab} onValueChange={(v) => setTab(v as RightTab)} className="flex min-h-0 flex-1 flex-col">
              <div className="border-b px-2 py-2">
                <TabsList className="w-full">
                  <TabsTrigger value="assistant" className="flex-1 gap-1.5">
                    <Icon name="sparkles" size={14} /> Assistant
                  </TabsTrigger>
                  <TabsTrigger value="inspector" className="flex-1 gap-1.5">
                    <Icon name="settings" size={14} /> Inspect
                  </TabsTrigger>
                  <TabsTrigger value="export" className="flex-1 gap-1.5">
                    <Icon name="download" size={14} /> Export
                  </TabsTrigger>
                </TabsList>
              </div>
              {/* Render panels without TabsContent so chat state survives tab switches. */}
              <div className="min-h-0 flex-1 overflow-hidden">
                <div className={cn("h-full", tab !== "assistant" && "hidden")}>
                  <AssistantPanel getModel={getModel} onApply={applyModel} />
                </div>
                <div className={cn("h-full overflow-y-auto", tab !== "inspector" && "hidden")}>
                  <Inspector
                    entity={selectedEntity}
                    relation={selectedRelation}
                    entities={entityList}
                    onUpdateEntity={updateEntity}
                    onUpdateProperty={updateProperty}
                    onAddProperty={addProperty}
                    onRemoveProperty={removeProperty}
                    onMoveProperty={moveProperty}
                    onDeleteEntity={deleteEntity}
                    onUpdateRelation={updateRelation}
                    onSwapRelation={swapRelation}
                    onDeleteRelation={deleteRelation}
                  />
                </div>
                <div className={cn("h-full", tab !== "export" && "hidden")}>
                  <ExportPanel model={tab === "export" ? model : EXPORT_IDLE_MODEL} active={tab === "export"} />
                </div>
              </div>
            </Tabs>
          </div>
        )}
      </div>

      <Dialog open={saveDialog} onOpenChange={setSaveDialog}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Store editor metadata?</DialogTitle>
            <DialogDescription>
              Embedding metadata adds a <code className="font-mono text-[12px]">// @canopy-model</code> comment
              so this document re-opens with the exact same layout, colors, and property types. Choose pure
              Prisma for a clean schema (positions and some type details are recreated on next open).
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Checkbox
              checked={rememberMeta}
              onCheckedChange={(c) => setRememberMeta(c === true)}
              className="h-4 w-4"
            />
            Remember my choice for this document
          </label>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              onClick={() => {
                if (rememberMeta) setMetaPref("plain");
                setSaveDialog(false);
                void writeFile(false);
              }}
            >
              Pure Prisma
            </Button>
            <Button
              onClick={() => {
                if (rememberMeta) setMetaPref("embed");
                setSaveDialog(false);
                void writeFile(true);
              }}
            >
              Embed metadata
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ModelEditorView({ file }: { file?: FileBinding } = {}) {
  return (
    <ReactFlowProvider>
      <Editor file={file} />
    </ReactFlowProvider>
  );
}
