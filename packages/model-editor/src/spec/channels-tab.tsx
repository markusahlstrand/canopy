import { useMemo } from "react";
import { Icon } from "@canopy/ui";
import { cn } from "@canopy/ui";
import type { SpecChannel } from "./graph-types";
import type { SpecViewProps } from "./view-types";

const ACTION_TONE = {
  send: "bg-emerald-500/10 text-emerald-600",
  receive: "bg-sky-500/10 text-sky-600",
} as const;

/** The Channels list shares the view's tag filter with the other tabs. */
export interface ChannelsTabProps extends SpecViewProps {
  /** Active tag include-filter (empty ⇒ show all). */
  tagFilter: string[];
}

/** Events (AsyncAPI channels) as a list grouped by protocol, linked to entities + endpoints. */
export function ChannelsTab({ graph, index, selection, related, onSelect, onNavigate, tagFilter }: ChannelsTabProps) {
  const errored = useMemo(
    () => new Set(graph.diagnostics.filter((d) => d.target?.kind === "channel").map((d) => d.target!.id)),
    [graph.diagnostics],
  );
  const groups = useMemo(() => {
    const map = new Map<string, SpecChannel[]>();
    for (const c of graph.channels) {
      if (tagFilter.length && !c.tags?.some((t) => tagFilter.includes(t))) continue;
      const key = c.protocols?.length ? c.protocols.join(", ") : "Channels";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    return [...map.entries()];
  }, [graph.channels, tagFilter]);

  if (!graph.channels.length) {
    return <div className="grid h-full place-items-center text-sm text-muted-foreground">No AsyncAPI channels found in this project.</div>;
  }
  if (!groups.length) {
    return <div className="grid h-full place-items-center text-sm text-muted-foreground">No channels match the active tag filter.</div>;
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-4">
      {groups.map(([group, channels]) => (
        <div key={group} className="mb-5">
          <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Icon name="radio" size={13} /> {group}
            <span className="font-mono text-[10px]">({channels.length})</span>
          </div>
          <div className="overflow-hidden rounded-lg border">
            {channels.map((c) => {
              const active = selection?.kind === "channel" && selection.id === c.id;
              const dim = related.channels.size > 0 && !related.channels.has(c.id);
              const endpoint = index.endpointForChannel(c);
              const models = index.modelsForChannel(c.id);
              return (
                <div key={c.id} className={cn("border-b last:border-b-0 transition", dim && "opacity-40", active && "bg-accent/50")}>
                  <button onClick={() => onSelect({ kind: "channel", id: c.id })} className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-accent/40">
                    <div className="flex w-14 shrink-0 gap-1">
                      {c.operations.length ? c.operations.map((op) => (
                        <span key={op.id} title={`${op.action} · ${op.id}`} className={cn("rounded px-1 py-0.5", ACTION_TONE[op.action])}>
                          <Icon name={op.action === "send" ? "send" : "inbox"} size={11} />
                        </span>
                      )) : <span className="rounded bg-muted px-1.5 py-0.5 text-center font-mono text-[10px] text-muted-foreground">ch</span>}
                    </div>
                    <span className="shrink-0 font-mono text-[13px] font-semibold">{c.name}</span>
                    {c.address && c.address !== c.name && <span className="truncate font-mono text-[11px] text-muted-foreground">{c.address}</span>}
                    {c.tags?.map((t) => (
                      <span key={t} className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 font-mono text-[9px] text-accent-foreground">#{t}</span>
                    ))}
                    {errored.has(c.id) && <Icon name="alert-triangle" size={13} className="ml-auto shrink-0 text-destructive" />}
                    {!errored.has(c.id) && endpoint && (
                      <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[10px] text-muted-foreground" title={`Linked to endpoint ${endpoint.operationId}`}>
                        <Icon name="globe" size={11} /> {endpoint.operationId}
                      </span>
                    )}
                  </button>
                  {active && (
                    <div className="space-y-2 border-t bg-muted/30 px-3 py-2.5 text-[12px]">
                      {c.doc && <p className="text-muted-foreground">{c.doc}</p>}
                      {!!c.messages.length && (
                        <div className="space-y-1">
                          <span className="text-[11px] text-muted-foreground">Messages:</span>
                          <ul className="space-y-1">
                            {c.messages.map((m) => {
                              const model = m.payloadRef ? index.modelById.get(m.payloadRef) : undefined;
                              return (
                                <li key={m.name} className="flex items-center gap-2">
                                  <Icon name="bell" size={11} className="shrink-0 text-muted-foreground" />
                                  <span className="font-mono text-[11px]">{m.name}</span>
                                  {model ? (
                                    <button onClick={() => onNavigate({ kind: "entity", id: model.id })} className="ml-auto truncate rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] text-primary hover:underline">
                                      {model.name}
                                    </button>
                                  ) : (
                                    (m.payloadRef || m.payloadType) && <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">{m.payloadRef ?? m.payloadType}</span>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      )}
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
                      {endpoint && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] text-muted-foreground">Endpoint:</span>
                          <button onClick={() => onNavigate({ kind: "endpoint", id: endpoint.id })} className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] hover:underline">
                            <Icon name="globe" size={10} /> {endpoint.operationId}
                          </button>
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
