import { useMemo } from "react";
import { Icon } from "@canopy/ui";
import { cn } from "@canopy/ui";
import type { SpecEndpoint } from "./graph-types";
import type { SpecViewProps } from "./view-types";

const VERB_TONE: Record<string, string> = {
  GET: "bg-sky-500/10 text-sky-600",
  POST: "bg-emerald-500/10 text-emerald-600",
  PUT: "bg-amber-500/10 text-amber-600",
  PATCH: "bg-amber-500/10 text-amber-600",
  DELETE: "bg-rose-500/10 text-rose-600",
};

/** The Endpoints list shares the view's tag filter with the graph tabs. */
export interface EndpointsTabProps extends SpecViewProps {
  /** Active tag include-filter (empty ⇒ show all). */
  tagFilter: string[];
}

/** Endpoints (TypeSpec operations) as a list grouped by their interface/namespace. */
export function EndpointsTab({ graph, index, selection, related, onSelect, onNavigate, tagFilter }: EndpointsTabProps) {
  const errored = useMemo(
    () => new Set(graph.diagnostics.filter((d) => d.target?.kind === "endpoint").map((d) => d.target!.id)),
    [graph.diagnostics],
  );
  const groups = useMemo(() => {
    const map = new Map<string, SpecEndpoint[]>();
    for (const e of graph.endpoints) {
      if (tagFilter.length && !e.tags?.some((t) => tagFilter.includes(t))) continue;
      const key = e.group ?? e.namespace ?? "Operations";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return [...map.entries()];
  }, [graph.endpoints, tagFilter]);

  if (!graph.endpoints.length) {
    return <div className="grid h-full place-items-center text-sm text-muted-foreground">No TypeSpec operations found in this project.</div>;
  }
  if (!groups.length) {
    return <div className="grid h-full place-items-center text-sm text-muted-foreground">No operations match the active tag filter.</div>;
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-4">
      {groups.map(([group, endpoints]) => (
        <div key={group} className="mb-5">
          <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Icon name="package" size={13} /> {group}
            <span className="font-mono text-[10px]">({endpoints.length})</span>
          </div>
          <div className="overflow-hidden rounded-lg border">
            {endpoints.map((e) => {
              const active = selection?.kind === "endpoint" && selection.id === e.id;
              const dim = related.endpoints.size > 0 && !related.endpoints.has(e.id);
              const flows = index.flowsCallingEndpoint(e.id);
              const models = index.modelsForEndpoint(e.id);
              return (
                <div key={e.id} className={cn("border-b last:border-b-0 transition", dim && "opacity-40", active && "bg-accent/50")}>
                  <button onClick={() => onSelect({ kind: "endpoint", id: e.id })} className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-accent/40">
                    <span className={cn("w-14 shrink-0 rounded px-1.5 py-0.5 text-center font-mono text-[10px] font-semibold", VERB_TONE[e.verb?.toUpperCase() ?? ""] ?? "bg-muted text-muted-foreground")}>
                      {e.verb?.toUpperCase() ?? "OP"}
                    </span>
                    <span className="shrink-0 font-mono text-[13px] font-semibold">{e.operationId}</span>
                    {e.route && <span className="truncate font-mono text-[11px] text-muted-foreground">{e.route}</span>}
                    {e.tags?.map((t) => (
                      <span key={t} className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 font-mono text-[9px] text-accent-foreground">#{t}</span>
                    ))}
                    {errored.has(e.id) && <Icon name="alert-triangle" size={13} className="ml-auto shrink-0 text-destructive" />}
                    {!errored.has(e.id) && !!flows.length && (
                      <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[10px] text-muted-foreground" title="Called by flows">
                        <Icon name="board" size={11} /> {flows.length}
                      </span>
                    )}
                  </button>
                  {active && (
                    <div className="space-y-2 border-t bg-muted/30 px-3 py-2.5 text-[12px]">
                      {e.doc && <p className="text-muted-foreground">{e.doc}</p>}
                      {!!models.length && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] text-muted-foreground">Entities:</span>
                          {models.map((m) => (
                            <button key={m.id} onClick={() => onNavigate({ kind: "entity", id: m.id })} className={cn("rounded px-1.5 py-0.5 font-mono text-[11px] hover:underline", m.isError ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary")}>
                              {m.name}
                            </button>
                          ))}
                        </div>
                      )}
                      {!!flows.length && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] text-muted-foreground">Called by:</span>
                          {flows.map((f) => (
                            <button key={f.id} onClick={() => onNavigate({ kind: "flow", id: f.id })} className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] hover:underline">
                              <Icon name="board" size={10} /> {f.workflowId}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
