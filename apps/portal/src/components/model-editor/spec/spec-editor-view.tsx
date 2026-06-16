import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { ProjectGraph, SelectionRef } from "./graph-types";
import { SpecIndex } from "./links";
import { EntitiesTab } from "./entities-tab";
import { EndpointsTab } from "./endpoints-tab";
import { FlowsTab } from "./flows-tab";
import { SourceTab } from "./source-tab";
import { SpecInspector } from "./spec-inspector";
import { DiagnosticsBar } from "./diagnostics-bar";
import { tabForKind, type SpecTab, type SpecViewProps } from "./view-types";

const FileChips = ({ graph }: { graph: ProjectGraph }) => (
  <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
    {graph.files.tsp.length > 0 && <span className="flex items-center gap-1" title={graph.files.tsp.join(", ")}><Icon name="file-code" size={12} /> {graph.files.tsp.length} tsp</span>}
    {graph.files.openapi.length > 0 && <span className="flex items-center gap-1" title={graph.files.openapi.join(", ")}><Icon name="globe" size={12} /> {graph.files.openapi.length} openapi</span>}
    {graph.files.arazzo.length > 0 && <span className="flex items-center gap-1" title={graph.files.arazzo.join(", ")}><Icon name="board" size={12} /> {graph.files.arazzo.length} arazzo</span>}
  </div>
);

/**
 * The three-tab spec workspace. Selection lives here so it follows across tabs:
 * `onSelect` highlights the related items everywhere (via {@link SpecIndex.related})
 * while staying put; `onNavigate` is the cross-layer jump that also switches tab.
 */
export function SpecEditorView({
  graph,
  fileName,
  onReload,
  reloading,
}: {
  graph: ProjectGraph;
  fileName: string;
  onReload?: () => void;
  reloading?: boolean;
}) {
  const [tab, setTab] = useState<SpecTab>(graph.endpoints.length || graph.models.length ? "entities" : "flows");
  const [selection, setSelection] = useState<SelectionRef | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [diagOpen, setDiagOpen] = useState(false);

  const index = useMemo(() => new SpecIndex(graph), [graph]);
  const related = useMemo(() => index.related(selection), [index, selection]);

  const onSelect = (ref: SelectionRef | null) => setSelection(ref);
  const onNavigate = (ref: SelectionRef) => {
    setSelection(ref);
    setTab(tabForKind(ref.kind));
    setPanelOpen(true);
  };

  const shared: SpecViewProps = { graph, index, selection, related, onSelect, onNavigate };

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
            <TabsTrigger value="entities" className="gap-1.5"><Icon name="database" size={14} /> Entities <span className="font-mono text-[10px] text-muted-foreground">{graph.models.length}</span></TabsTrigger>
            <TabsTrigger value="endpoints" className="gap-1.5"><Icon name="globe" size={14} /> Endpoints <span className="font-mono text-[10px] text-muted-foreground">{graph.endpoints.length}</span></TabsTrigger>
            <TabsTrigger value="flows" className="gap-1.5"><Icon name="board" size={14} /> Flows <span className="font-mono text-[10px] text-muted-foreground">{graph.flows.length}</span></TabsTrigger>
            <TabsTrigger value="source" className="gap-1.5"><Icon name="file-code" size={14} /> Source <span className="font-mono text-[10px] text-muted-foreground">{graph.sourceFiles.length}</span></TabsTrigger>
          </TabsList>
        </Tabs>
        <FileChips graph={graph} />
        <div className="ml-auto flex items-center gap-1">
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
              Flows is a separate artifact referencing it. Mount only the active tab so
              each React Flow canvas measures correctly. */}
          {tab === "entities" && <EntitiesTab {...shared} />}
          {tab === "endpoints" && <EndpointsTab {...shared} />}
          {tab === "flows" && <FlowsTab {...shared} />}
          {tab === "source" && <SourceTab {...shared} />}
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
