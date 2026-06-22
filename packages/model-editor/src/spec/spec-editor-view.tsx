import { useCallback, useMemo, useState } from "react";
import { Button } from "@canopy/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@canopy/ui";
import { Tabs, TabsList, TabsTrigger } from "@canopy/ui";
import { Icon } from "@canopy/ui";
import { cn } from "@canopy/ui";
import type { ProjectGraph, SelectionRef } from "./graph-types";
import { SpecIndex } from "./links";
import { EntitiesTab } from "./entities-tab";
import { EndpointsTab } from "./endpoints-tab";
import { ChannelsTab } from "./channels-tab";
import { FlowsTab } from "./flows-tab";
import { SourceTab } from "./source-tab";
import { SpecInspector } from "./spec-inspector";
import { DiagnosticsBar } from "./diagnostics-bar";
import { useLayout, type CommitLayoutFn } from "./use-layout";
import { tabForKind, type SpecTab, type SpecViewProps } from "./view-types";

const FileChips = ({ graph }: { graph: ProjectGraph }) => (
  <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
    {graph.files.tsp.length > 0 && <span className="flex items-center gap-1" title={graph.files.tsp.join(", ")}><Icon name="file-code" size={12} /> {graph.files.tsp.length} tsp</span>}
    {graph.files.openapi.length > 0 && <span className="flex items-center gap-1" title={graph.files.openapi.join(", ")}><Icon name="globe" size={12} /> {graph.files.openapi.length} openapi</span>}
    {graph.files.asyncapi.length > 0 && <span className="flex items-center gap-1" title={graph.files.asyncapi.join(", ")}><Icon name="radio" size={12} /> {graph.files.asyncapi.length} asyncapi</span>}
    {graph.files.arazzo.length > 0 && <span className="flex items-center gap-1" title={graph.files.arazzo.join(", ")}><Icon name="board" size={12} /> {graph.files.arazzo.length} arazzo</span>}
  </div>
);

/**
 * The spec workspace (Entities · Endpoints · Events · Flows · Source). Selection
 * lives here so it follows across tabs:
 * `onSelect` highlights the related items everywhere (via {@link SpecIndex.related})
 * while staying put; `onNavigate` is the cross-layer jump that also switches tab.
 */
export function SpecEditorView({
  graph,
  fileName,
  projectKey,
  onCommitLayout,
  onReload,
  reloading,
}: {
  graph: ProjectGraph;
  fileName: string;
  /** Stable id for the project folder — keys persisted entity layout. */
  projectKey: string;
  /** Writes the layout sidecar to the repo; absent when the host can't write. */
  onCommitLayout?: CommitLayoutFn;
  onReload?: () => void;
  reloading?: boolean;
}) {
  const [tab, setTab] = useState<SpecTab>(
    graph.endpoints.length || graph.models.length ? "entities" : graph.flows.length ? "flows" : graph.channels.length ? "channels" : "flows",
  );
  const [selection, setSelection] = useState<SelectionRef | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [diagOpen, setDiagOpen] = useState(false);
  // A request to reveal a line in the Source tab; the nonce re-triggers the scroll
  // even when the same target is opened twice.
  const [reveal, setReveal] = useState<{ file: string; line?: number; nonce: number } | null>(null);
  // Entities-only by default; fall back to showing DTOs when the spec has no entities,
  // so the canvas is never mysteriously empty.
  const [showDtos, setShowDtos] = useState(() => !graph.models.some((m) => m.role === "entity"));
  const entityCount = useMemo(() => graph.models.filter((m) => m.role !== "dto").length, [graph.models]);
  const dtoCount = graph.models.length - entityCount;
  // Every tag declared across the contract + workflows, for the filter picker.
  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const m of graph.models) m.tags?.forEach((t) => s.add(t));
    for (const f of graph.flows) f.tags?.forEach((t) => s.add(t));
    for (const e of graph.endpoints) e.tags?.forEach((t) => s.add(t));
    for (const c of graph.channels) c.tags?.forEach((t) => s.add(t));
    return [...s].sort();
  }, [graph.models, graph.flows, graph.endpoints, graph.channels]);

  const index = useMemo(() => new SpecIndex(graph), [graph]);
  const related = useMemo(() => index.related(selection), [index, selection]);
  const layout = useLayout(projectKey, graph, onCommitLayout);
  const activeView = layout.views.find((v) => v.id === layout.activeViewId);

  // Stable identities: these flow into node `data` (e.g. each entity's onPick), so a
  // fresh arrow per render would invalidate every node object on every drag frame.
  const onSelect = useCallback((ref: SelectionRef | null) => setSelection(ref), []);
  const onNavigate = useCallback((ref: SelectionRef) => {
    setSelection(ref);
    setTab(tabForKind(ref.kind));
    setPanelOpen(true);
  }, []);
  const onOpenSource = useCallback((file: string, line?: number) => {
    setReveal((r) => ({ file, line, nonce: (r?.nonce ?? 0) + 1 }));
    setTab("source");
  }, []);
  const toggleTag = (t: string) =>
    layout.setTagFilter(layout.tagFilter.includes(t) ? layout.tagFilter.filter((x) => x !== t) : [...layout.tagFilter, t]);

  const shared: SpecViewProps = { graph, index, projectKey, selection, related, onSelect, onNavigate, onOpenSource };

  return (
    <div className="flex h-full w-full flex-col bg-background">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <Icon name="share" size={18} className="shrink-0 text-primary" />
          <span className="max-w-[220px] truncate font-mono text-[13px] font-semibold" title={fileName}>{fileName}</span>
        </div>
        <Tabs value={tab} onValueChange={(v) => setTab(v as SpecTab)}>
          <TabsList>
            <TabsTrigger value="entities" className="gap-1.5"><Icon name="database" size={14} /> Entities <span className="font-mono text-[10px] text-muted-foreground">{showDtos ? graph.models.length : entityCount}</span></TabsTrigger>
            <TabsTrigger value="endpoints" className="gap-1.5"><Icon name="globe" size={14} /> Endpoints <span className="font-mono text-[10px] text-muted-foreground">{graph.endpoints.length}</span></TabsTrigger>
            <TabsTrigger value="channels" className="gap-1.5"><Icon name="radio" size={14} /> Events <span className="font-mono text-[10px] text-muted-foreground">{graph.channels.length}</span></TabsTrigger>
            <TabsTrigger value="flows" className="gap-1.5"><Icon name="board" size={14} /> Flows <span className="font-mono text-[10px] text-muted-foreground">{graph.flows.length}</span></TabsTrigger>
            <TabsTrigger value="source" className="gap-1.5"><Icon name="file-code" size={14} /> Source <span className="font-mono text-[10px] text-muted-foreground">{graph.sourceFiles.length}</span></TabsTrigger>
          </TabsList>
        </Tabs>
        <FileChips graph={graph} />
        <div className="ml-auto flex items-center gap-1.5">
          {tab === "entities" && dtoCount > 0 && (
            <Button
              variant={showDtos ? "secondary" : "outline"}
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => setShowDtos((v) => !v)}
              title={showDtos ? "Hide request/response DTOs — show entities only" : "Show request/response DTOs alongside entities"}
            >
              <Icon name={showDtos ? "eye-off" : "eye"} size={14} />
              {showDtos ? "Hide DTOs" : "Show DTOs"}
              <span className="font-mono text-[10px] text-muted-foreground">{dtoCount}</span>
            </Button>
          )}
          {tab !== "source" && allTags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant={layout.tagFilter.length ? "secondary" : "outline"} size="sm" className="h-8 gap-1.5" title="Filter this view by tag">
                  <Icon name="tag" size={14} />
                  {layout.tagFilter.length ? `${layout.tagFilter.length} tag${layout.tagFilter.length > 1 ? "s" : ""}` : "Tags"}
                  <Icon name="chevron-down" size={12} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel>Filter by tag</DropdownMenuLabel>
                {allTags.map((t) => (
                  <DropdownMenuItem key={t} onSelect={(e) => { e.preventDefault(); toggleTag(t); }} className="gap-2">
                    <Icon name="circle-check" size={13} className={cn(layout.tagFilter.includes(t) ? "text-primary" : "opacity-0")} />
                    <span className="flex-1 truncate font-mono text-[12px]">#{t}</span>
                  </DropdownMenuItem>
                ))}
                {layout.tagFilter.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => layout.setTagFilter([])} className="gap-2"><Icon name="restore" size={13} /> Clear filter</DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {((tab === "entities" && graph.models.length > 0) || (tab === "flows" && graph.flows.length > 0)) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 gap-1.5" title="Saved layout views">
                  <Icon name="grid" size={14} />
                  <span className="max-w-[120px] truncate">{activeView?.name ?? "Default"}</span>
                  <Icon name="chevron-down" size={12} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Views ({layout.views.length})</DropdownMenuLabel>
                {layout.views.map((v) => (
                  <DropdownMenuItem key={v.id} onClick={() => layout.switchView(v.id)} className="gap-2">
                    <Icon name="circle-check" size={13} className={cn(v.id === layout.activeViewId ? "text-primary" : "opacity-0")} />
                    <span className="flex-1 truncate">{v.name}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">{Object.keys(v.entities).length + Object.keys(v.steps ?? {}).length}</span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={layout.addView} className="gap-2"><Icon name="plus" size={13} /> New view</DropdownMenuItem>
                <DropdownMenuItem onClick={layout.renameView} className="gap-2"><Icon name="edit" size={13} /> Rename view</DropdownMenuItem>
                <DropdownMenuItem onClick={layout.deleteView} disabled={layout.views.length <= 1} className="gap-2"><Icon name="trash" size={13} /> Delete view</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {layout.dirty && (
            <Button
              size="sm"
              className="h-8 gap-1.5"
              onClick={layout.commit}
              disabled={layout.committing || !layout.canCommit}
              title={layout.canCommit ? "Write canopy.layout.json back to the repo" : "This location is read-only — layout is staged locally"}
            >
              <Icon name={layout.committing ? "refresh" : "cloud"} size={14} className={layout.committing ? "animate-spin" : ""} />
              {layout.committing ? "Committing…" : layout.canCommit ? "Commit layout" : "Staged"}
            </Button>
          )}
          {onReload && (
            <Button variant="ghost" size="icon-sm" onClick={onReload} title="Re-read files & rebuild graph" disabled={reloading}>
              <Icon name="refresh" size={16} className={reloading ? "animate-spin" : ""} />
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" onClick={() => setPanelOpen((v) => !v)} title={panelOpen ? "Hide panel" : "Show panel"}>
            <Icon name={panelOpen ? "panel-right" : "panel-left"} size={16} />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {/* Conceptually Entities + Endpoints are two projections of one contract;
              Channels (events) and Flows are separate artifacts referencing it. Mount
              only the active tab so each React Flow canvas measures correctly. */}
          {tab === "entities" && (
            <EntitiesTab {...shared} positions={layout.positions} onMove={layout.move} onResetLayout={layout.resetActive} hasOverrides={layout.hasOverrides} showDtos={showDtos} tagFilter={layout.tagFilter} />
          )}
          {tab === "endpoints" && <EndpointsTab {...shared} tagFilter={layout.tagFilter} />}
          {tab === "channels" && <ChannelsTab {...shared} tagFilter={layout.tagFilter} />}
          {tab === "flows" && (
            <FlowsTab {...shared} stepPositions={layout.stepPositions} onMoveStep={layout.moveStep} onResetSteps={layout.resetSteps} hasStepOverrides={layout.hasStepOverrides} tagFilter={layout.tagFilter} />
          )}
          {tab === "source" && <SourceTab {...shared} reveal={reveal} />}
        </div>
        {panelOpen && tab !== "source" && (
          <div className={cn("w-[340px] shrink-0 border-l bg-background", tab === "flows" ? "border-l-emerald-500/20" : "")}>
            <SpecInspector {...shared} />
          </div>
        )}
      </div>

      <DiagnosticsBar diagnostics={graph.diagnostics} open={diagOpen} onToggle={() => setDiagOpen((v) => !v)} onNavigate={onNavigate} />
    </div>
  );
}
