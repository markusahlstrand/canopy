import { Icon } from "@canopy/ui";
import { cn } from "@canopy/ui";
import { locate, type SourceLocation } from "./source-locate";
import type { SpecViewProps } from "./view-types";

/** A clickable row that navigates to another item (the cross-layer jump). */
function LinkRow({ icon, label, sub, onClick, tone }: { icon: string; label: string; sub?: string; onClick: () => void; tone?: "error" }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition hover:bg-accent"
    >
      <Icon name={icon} size={13} className={cn("shrink-0", tone === "error" ? "text-destructive" : "text-muted-foreground")} />
      <span className="truncate font-medium">{label}</span>
      {sub && <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">{sub}</span>}
      <Icon name="chevron-right" size={12} className="shrink-0 text-muted-foreground" />
    </button>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <div className="border-t px-3 py-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
        {count != null && <span className="font-mono text-[10px]">({count})</span>}
      </div>
      <div className="-mx-1">{children}</div>
    </div>
  );
}

const Empty = ({ text }: { text: string }) => <div className="px-2 py-1 text-[12px] italic text-muted-foreground">{text}</div>;

/**
 * The shared detail + find-usages panel. It reads the current selection and renders
 * the item's details plus its cross-layer usages, every one a button that jumps to
 * the related item in its own tab. This is where "find usages" lives.
 */
export function SpecInspector({ graph, index, selection, onNavigate, onSelect, onOpenSource }: SpecViewProps) {
  const loc = selection ? locate(graph, selection) : undefined;
  const headerSource = { loc, onOpenSource };

  if (!selection) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
        <Icon name="link" size={22} />
        <p className="text-[12px]">Select an entity, endpoint, or flow step to see its details and what references it across the other layers.</p>
      </div>
    );
  }

  const nameOf = (id: string) => index.modelById.get(id)?.name ?? id;

  if (selection.kind === "entity") {
    const m = index.modelById.get(selection.id);
    if (!m) return <Empty text="This entity is no longer in the model." />;
    const endpoints = index.endpointsUsingModel(m.id);
    const flows = index.flowsReachingModel(m.id);
    return (
      <div className="flex h-full flex-col overflow-y-auto">
        <Header icon={m.kind === "enum" ? "list" : "database"} kind={m.kind === "enum" ? "Enum" : "Entity"} title={m.name} doc={m.doc} {...headerSource} />
        {m.kind === "enum" ? (
          <Section title="Values" count={m.enumValues?.length}>
            <div className="flex flex-wrap gap-1 px-1">
              {(m.enumValues ?? []).map((v) => (
                <span key={v} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{v}</span>
              ))}
            </div>
          </Section>
        ) : (
          <Section title="Fields" count={m.fields.length}>
            <ul className="px-1">
              {m.fields.map((f) => (
                <li key={f.name} className="flex items-center gap-2 py-1 text-[12px]">
                  {f.key && <span title="Key" className="font-mono text-[10px] text-amber-500">KEY</span>}
                  <span className="font-medium">{f.name}</span>
                  {f.optional && <span className="text-muted-foreground">?</span>}
                  {f.ref ? (
                    <button onClick={() => onNavigate({ kind: "entity", id: f.ref! })} className="ml-auto truncate font-mono text-[11px] text-primary hover:underline">
                      {f.type}
                    </button>
                  ) : (
                    <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">{f.type}</span>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        )}
        <Section title="Used by endpoints" count={endpoints.length}>
          {endpoints.length ? endpoints.map((e) => (
            <LinkRow key={e.id} icon="globe" label={e.operationId} sub={e.verb?.toUpperCase()} onClick={() => onNavigate({ kind: "endpoint", id: e.id })} />
          )) : <Empty text="No endpoint references this entity." />}
        </Section>
        <Section title="Reached by flows" count={flows.length}>
          {flows.length ? flows.map((f) => (
            <LinkRow key={f.id} icon="board" label={f.workflowId} onClick={() => onNavigate({ kind: "flow", id: f.id })} />
          )) : <Empty text="No flow reaches this entity." />}
        </Section>
      </div>
    );
  }

  if (selection.kind === "endpoint") {
    const e = index.endpointById.get(selection.id);
    if (!e) return <Empty text="This endpoint is no longer in the contract." />;
    const steps = index.stepsCallingEndpoint(e.id);
    return (
      <div className="flex h-full flex-col overflow-y-auto">
        <Header icon="globe" kind="Endpoint" title={e.operationId} doc={e.doc} mono={`${e.verb?.toUpperCase() ?? ""} ${e.route ?? ""}`.trim()} {...headerSource} />
        <Section title="Parameters" count={e.parameters.length}>
          {e.parameters.length ? (
            <ul className="px-1">
              {e.parameters.map((p) => (
                <li key={p.name} className="flex items-center gap-2 py-1 text-[12px]">
                  {p.in && <span className="rounded bg-muted px-1 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">{p.in}</span>}
                  <span className="font-medium">{p.name}</span>
                  {p.optional && <span className="text-muted-foreground">?</span>}
                  {p.ref ? (
                    <button onClick={() => onNavigate({ kind: "entity", id: p.ref! })} className="ml-auto truncate font-mono text-[11px] text-primary hover:underline">{nameOf(p.ref)}</button>
                  ) : <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">{p.type}</span>}
                </li>
              ))}
            </ul>
          ) : <Empty text="No parameters." />}
        </Section>
        <Section title="Responses" count={e.responses.length}>
          {e.responses.length ? e.responses.map((res, i) => (
            res.ref ? (
              <LinkRow key={i} icon={res.isError ? "alert-triangle" : "database"} tone={res.isError ? "error" : undefined} label={nameOf(res.ref)} sub={res.status} onClick={() => onNavigate({ kind: "entity", id: res.ref! })} />
            ) : <div key={i} className="px-2 py-1 text-[12px] text-muted-foreground">{res.status}</div>
          )) : <Empty text="No typed responses." />}
        </Section>
        <Section title="Called by flows" count={steps.length}>
          {steps.length ? steps.map((s) => (
            <LinkRow key={s.id} icon="board" label={s.stepId} sub={s.workflowId} onClick={() => onNavigate({ kind: "step", id: s.id })} />
          )) : <Empty text="No flow step calls this endpoint." />}
        </Section>
      </div>
    );
  }

  if (selection.kind === "flow") {
    const f = index.flowById.get(selection.id);
    if (!f) return <Empty text="This flow is gone." />;
    return (
      <div className="flex h-full flex-col overflow-y-auto">
        <Header icon="board" kind="Workflow" title={f.workflowId} doc={f.summary} {...headerSource} />
        {!!f.inputs.length && <Section title="Inputs"><div className="flex flex-wrap gap-1 px-1">{f.inputs.map((i) => <span key={i} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{i}</span>)}</div></Section>}
        <Section title="Steps" count={f.steps.length}>
          {f.steps.map((s) => (
            <LinkRow key={s.id} icon="circle-check" label={s.stepId} sub={s.operationId} onClick={() => onNavigate({ kind: "step", id: s.id })} />
          ))}
        </Section>
        {!!f.outputs.length && <Section title="Outputs"><div className="flex flex-wrap gap-1 px-1">{f.outputs.map((o) => <span key={o} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{o}</span>)}</div></Section>}
      </div>
    );
  }

  // step
  const s = index.stepById.get(selection.id);
  if (!s) return <Empty text="This step is gone." />;
  const ep = index.endpointForStep(s);
  const deps = s.dependsOn.map((id) => index.stepById.get(id)).filter(Boolean);
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <Header icon="circle-check" kind={`Step · ${s.workflowId}`} title={s.stepId} doc={s.description} {...headerSource} />
      <Section title="Calls endpoint">
        {s.operationId ? (
          ep ? <LinkRow icon="globe" label={ep.operationId} sub={ep.verb?.toUpperCase()} onClick={() => onNavigate({ kind: "endpoint", id: ep.id })} />
            : <LinkRow icon="alert-triangle" tone="error" label={s.operationId} sub="unresolved" onClick={() => onSelect(selection)} />
        ) : s.callsWorkflowId ? <LinkRow icon="board" label={s.callsWorkflowId} onClick={() => onNavigate({ kind: "flow", id: s.callsWorkflowId! })} /> : <Empty text="No operation bound." />}
      </Section>
      {!!deps.length && (
        <Section title="Depends on" count={deps.length}>
          {deps.map((d) => <LinkRow key={d!.id} icon="link" label={d!.stepId} onClick={() => onNavigate({ kind: "step", id: d!.id })} />)}
        </Section>
      )}
      {!!s.successCriteria.length && (
        <Section title="Success criteria" count={s.successCriteria.length}>
          <ul className="px-2">{s.successCriteria.map((c, i) => <li key={i} className="py-0.5 font-mono text-[11px] text-muted-foreground">{c}</li>)}</ul>
        </Section>
      )}
      {!!s.branches.length && (
        <Section title="On success / failure" count={s.branches.length}>
          {s.branches.map((b, i) => (
            <div key={i} className="flex items-center gap-2 px-2 py-1 text-[12px]">
              <span className={cn("rounded px-1 py-0.5 font-mono text-[9px] uppercase", b.on === "failure" ? "bg-destructive/10 text-destructive" : "bg-emerald-500/10 text-emerald-600")}>{b.on}</span>
              <span className="text-muted-foreground">{b.type}</span>
              {b.stepId && <button onClick={() => onNavigate({ kind: "step", id: `${s.workflowId}::${b.stepId}` })} className="font-medium text-primary hover:underline">{b.stepId}</button>}
            </div>
          ))}
        </Section>
      )}
      {!!s.outputs.length && (
        <Section title="Outputs"><div className="flex flex-wrap gap-1 px-1">{s.outputs.map((o) => <span key={o} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{o}</span>)}</div></Section>
      )}
    </div>
  );
}

function Header({
  icon,
  kind,
  title,
  doc,
  mono,
  loc,
  onOpenSource,
}: {
  icon: string;
  kind: string;
  title: string;
  doc?: string;
  mono?: string;
  loc?: SourceLocation;
  onOpenSource?: (file: string, line?: number) => void;
}) {
  return (
    <div className="px-3 py-3">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon name={icon} size={13} /> {kind}
      </div>
      <div className="mt-0.5 break-words font-mono text-[15px] font-semibold">{title}</div>
      {mono && <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{mono}</div>}
      {doc && <p className="mt-1.5 text-[12px] text-muted-foreground">{doc}</p>}
      {loc && onOpenSource && (
        <button
          onClick={() => onOpenSource(loc.file, loc.line)}
          title={`Open ${loc.file}${loc.line ? `:${loc.line}` : ""} in the Source tab`}
          className="mt-2 flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <Icon name="file-code" size={12} /> View source
          <span className="font-mono text-[10px] opacity-70">{loc.file}{loc.line ? `:${loc.line}` : ""}</span>
        </button>
      )}
    </div>
  );
}
