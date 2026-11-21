/**
 * One flow, on a canvas: its name and switches on top, the steps in the middle, and beside them
 * the selected step's details, what still stops it from saving, and what it would act on now.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Button, Checkbox, Icon, Input, Tabs, TabsList, TabsTrigger } from '@canopy/ui';
import { graphAsksModel, type FlowBranch } from '@canopy/scope-drive/spec/model';
import { getSpaceSettings, previewFlow, type FlowGraph, type FlowNode, type FlowPreview } from './api';
import type { SpaceCategory } from '../../src/space-settings';
import { FlowCanvas } from './flow-canvas';
import {
  addStep, allProblems, behaviourKey, connect, copiesWithoutApproval, disconnect, needsLayout, placeSteps, removeSteps, updateStep,
  type Names, type StepType,
} from './flow-graph-edit';
import { folderLabel, message, StepInspector, useFolderMap, type SpaceOption } from './flow-inspector';
import { layoutGraph } from './flow-layout';
import { draftJson, FlowRawEditor, readDraft, type RawStatus } from './flow-raw';

export type Draft = { id?: string; name: string; enabled: boolean; graph: FlowGraph };

/** `name` is what a screen reader hears: "Add a check", never "Add add label". */
const PALETTE: { type: StepType; label: string; name: string; icon: string }[] = [
  { type: 'check', label: 'Check', name: 'Add a check', icon: 'filter' },
  { type: 'approval', label: 'Wait for approval', name: 'Add a wait for approval', icon: 'inbox' },
  { type: 'copy', label: 'Copy', name: 'Add a copy', icon: 'send' },
  { type: 'label', label: 'Add label', name: 'Add a label', icon: 'tag' },
];

/** The categories of the spaces a flow watches, loaded per space: a category check picks from them. */
function useCategories(spaces: readonly string[]): { categories: SpaceCategory[]; error: string | null } {
  const [state, setState] = useState<{ categories: SpaceCategory[]; error: string | null }>({ categories: [], error: null });
  const key = [...new Set(spaces)].sort().join('\n');
  useEffect(() => {
    let live = true;
    const slugs = key ? key.split('\n') : [];
    void Promise.allSettled(slugs.map((slug) => getSpaceSettings(slug))).then((results) => {
      if (!live) return;
      const seen = new Map<string, SpaceCategory>();
      for (const r of results) if (r.status === 'fulfilled') for (const c of r.value.categories ?? []) if (!seen.has(c.id)) seen.set(c.id, c);
      const failed = results.some((r) => r.status === 'rejected');
      setState({ categories: [...seen.values()], error: failed ? 'Couldn’t load the categories of every space it watches.' : null });
    });
    return () => { live = false; };
  }, [key]);
  return state;
}

export function FlowEditor({ draft: initial, spaces, spaceName, busy, onSave, onCancel, onDirty }: {
  draft: Draft; spaces: readonly SpaceOption[]; spaceName: (slug: string) => string; busy: boolean;
  onSave: (draft: Draft, runExisting: boolean) => void; onCancel: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [baseline, setBaseline] = useState(() => JSON.stringify(initial));
  const [selected, setSelected] = useState<string | null>(null);
  const graph = draft.graph;
  const setGraph = useCallback((next: FlowGraph) => setDraft((d) => ({ ...d, graph: next })), []);

  // Goes up when the whole graph is replaced (from the JSON): a layout begun before then is for a
  // graph that is gone, so what it works out is dropped rather than put on the new one's steps.
  const generation = useRef(0);
  const current = (mine: number) => generation.current === mine;

  // A flow from before graphs has no positions: lay it out once, and count that as where it started.
  const laidOut = useRef(false);
  useEffect(() => {
    if (laidOut.current || !needsLayout(initial.graph)) return;
    laidOut.current = true;
    const mine = generation.current;
    void layoutGraph(initial.graph).then((positions) => {
      if (!current(mine)) return;
      setDraft((d) => {
        const next = { ...d, graph: placeSteps(d.graph, positions) };
        if (JSON.stringify(d) === JSON.stringify(initial)) setBaseline(JSON.stringify(next));
        return next;
      });
    });
  }, [initial]);
  const layOut = (from: FlowGraph) => {
    const mine = generation.current;
    void layoutGraph(from).then((positions) => { if (current(mine)) setDraft((d) => ({ ...d, graph: placeSteps(d.graph, positions) })); });
  };
  const tidy = () => layOut(graph);

  // The flow as JSON, while that view is open: the text, and what it was when opened (to tell an edit).
  const [raw, setRaw] = useState<{ text: string; from: string } | null>(null);
  const [rawStatus, setRawStatus] = useState<RawStatus>(null);
  const openRaw = () => { const text = draftJson(draft); setRaw({ text, from: text }); setRawStatus(null); };
  const ignoredNote = (ignored: string[]) => (ignored.length ? `Ignored ${ignored.join(', ')}: Canopy keeps ${ignored.length === 1 ? 'that' : 'those'} itself.` : null);
  /** Back to the canvas, with the text's changes when it can draw them. */
  const openCanvas = () => {
    if (!raw) return;
    if (raw.text === raw.from) { setRaw(null); return; }
    const read = readDraft(raw.text, draft.id, 'canvas');
    if (!read.ok) { setRawStatus({ kind: 'problems', problems: read.problems }); return; }
    generation.current++;
    setDraft(read.draft);
    setRaw(null);
    if (needsLayout(read.draft.graph)) layOut(read.draft.graph);
  };
  const checkRaw = () => {
    if (!raw) return;
    const read = readDraft(raw.text, draft.id, 'save');
    setRawStatus(read.ok ? { kind: 'note', text: ['This flow can be saved.', ignoredNote(read.ignored)].filter(Boolean).join(' ') } : { kind: 'problems', problems: read.problems });
  };
  /**
   * Save what the text says, once it passes what the server checks; never send what doesn't.
   * The draft stays as it was when the JSON opened: a save the server refuses leaves the text to
   * fix, and "Undo my changes" still goes back to the flow from before.
   */
  const saveRaw = () => {
    if (!raw) return;
    const read = readDraft(raw.text, draft.id, 'save');
    if (!read.ok) { setRawStatus({ kind: 'problems', problems: read.problems }); return; }
    setRawStatus(read.ignored.length ? { kind: 'note', text: ignoredNote(read.ignored)! } : null);
    // A run asked for on the canvas still holds when the JSON left what the flow does as it was.
    onSave(read.draft, runsExisting(read.draft));
  };

  const dirty = JSON.stringify(draft) !== baseline || (raw !== null && raw.text !== raw.from);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);

  const trigger = graph.nodes.find((n): n is Extract<FlowNode, { type: 'trigger' }> => n.type === 'trigger');
  const { categories, error: categoriesError } = useCategories(trigger?.spaces ?? []);
  const folders = useFolderMap(graph.nodes.flatMap((n) => (n.type === 'copy' && n.space ? [n.space] : [])));
  const names = useMemo<Names>(() => ({
    space: spaceName,
    category: (id) => categories.find((c) => c.id === id)?.name ?? id,
    folder: (space, id) => { const f = folders[space]?.find((x) => x.id === id); return f ? folderLabel(f.path) : undefined; },
  }), [spaceName, categories, folders]);

  const problems = useMemo(() => allProblems(graph), [graph]);
  const byStep = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of problems) if (p.node) map.set(p.node, [...(map.get(p.node) ?? []), p.message]);
    return map;
  }, [problems]);

  // The preview is for the graph as it acted when checked; moving steps around doesn't change that.
  const key = behaviourKey(graph);
  const [preview, setPreview] = useState<{ key: string; result: FlowPreview } | null>(null);
  const fresh = preview?.key === key ? preview.result : null;
  // Consent to run on what is there is for one preview: the graph it showed, as it was.
  const [runExisting, setRunExisting] = useState<string | null>(null);
  // Running on what is there is a backfill: a new scheduled flow's first run already covers it, and a flow that is off acts on nothing.
  const canRun = (d: Draft) => d.enabled && (d.graph.nodes.find((n) => n.type === 'trigger')?.on !== 'schedule' || Boolean(d.id));
  const canRunExisting = canRun(draft);
  /** Whether to run on what is there when saving `d`: asked for on a preview of what it does now. */
  const runsExisting = (d: Draft) => {
    const behaves = behaviourKey(d.graph);
    return runExisting === behaves && preview?.key === behaves && Boolean(preview.result.matched) && canRun(d);
  };

  const node = graph.nodes.find((n) => n.id === selected) ?? null;
  const add = (type: StepType) => {
    const result = addStep(graph, type, selected ?? undefined);
    setGraph(result.graph);
    setSelected(result.id);
  };
  const remove = () => { if (node && node.type !== 'trigger') { setGraph(removeSteps(graph, [node.id])); setSelected(null); } };
  const onConnect = (branch: FlowBranch, to: string | null) => {
    if (!node) return;
    setGraph(to ? connect(graph, node.id, branch, to) : disconnect(graph, node.id, branch));
  };
  const general = problems.filter((p) => !p.node);
  const blocked = busy || (!raw && (problems.length > 0 || !draft.name.trim()));

  return (
    <form aria-label={draft.id ? 'Edit flow' : 'New flow'} className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (blocked) return;
        if (raw) saveRaw();
        else onSave(draft, runsExisting(draft));
      }}>
      <div className="flex flex-wrap items-end gap-3 border-b px-4 py-3">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}><Icon name="chevron-left" size={14} /> All flows</Button>
        {raw ? <span className="flex-1" /> : <>
          <label className="min-w-48 flex-1 space-y-1"><span className="text-xs font-medium text-muted-foreground">Name</span>
            <Input aria-label="Flow name" value={draft.name} maxLength={100} placeholder="Statements to the gestoría" disabled={busy} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
          <label className="flex items-center gap-2 pb-2 text-sm"><Checkbox aria-label="Flow is on" checked={draft.enabled} disabled={busy} onCheckedChange={(on) => setDraft({ ...draft, enabled: on === true })} /> On</label>
          <label className="flex items-center gap-2 pb-2 text-sm"><Checkbox aria-label="Act again when a document gets a new version" checked={graph.versions === 'every'} disabled={busy}
            onCheckedChange={(on) => setGraph({ ...graph, versions: on === true ? 'every' : 'first' })} /> Act again when a document gets a new version</label>
        </>}
        <Tabs value={raw ? 'raw' : 'canvas'} onValueChange={(v) => (v === 'raw' ? openRaw() : openCanvas())} className="pb-0.5">
          <TabsList aria-label="Show the flow as">
            <TabsTrigger value="canvas" disabled={busy}><Icon name="model" size={14} /> Canvas</TabsTrigger>
            <TabsTrigger value="raw" disabled={busy}><Icon name="file-code" size={14} /> Raw JSON</TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="ml-auto flex gap-2 pb-0.5">
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
          <Button type="submit" disabled={blocked}>{busy ? 'Saving…' : 'Save flow'}</Button>
        </span>
      </div>

      {raw ? (
        <FlowRawEditor id={draft.id} text={raw.text} status={rawStatus} busy={busy}
          onChange={(text) => { setRaw({ ...raw, text }); setRawStatus(null); }} onCheck={checkRaw} onReset={openRaw} />
      ) : <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="relative min-h-[320px] min-w-0 flex-1 overflow-hidden">
          <div role="toolbar" aria-label="Add a step" className="absolute top-2 left-2 z-10 flex flex-wrap gap-1 rounded-lg border bg-background/95 p-1 shadow-sm">
            {PALETTE.map((p) => (
              <Button key={p.type} type="button" size="sm" variant="ghost" disabled={busy} onClick={() => add(p.type)} aria-label={p.name}>
                <Icon name={p.icon} size={14} /> {p.label}
              </Button>
            ))}
            <Button type="button" size="sm" variant="ghost" disabled={busy || !node || node.type === 'trigger'} onClick={remove} aria-label="Remove selected step"><Icon name="trash" size={14} /></Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={tidy}><Icon name="grid" size={14} /> Tidy up</Button>
          </div>
          <ReactFlowProvider>
            <FlowCanvas graph={graph} names={names} problems={byStep} counts={fresh ? { reach: fresh.reach, maybe: fresh.maybe } : null}
              selected={selected} busy={busy} onSelect={setSelected} onChange={setGraph} />
          </ReactFlowProvider>
        </div>

        <aside aria-label="Flow details" className="max-h-[50%] min-h-0 space-y-4 overflow-y-auto border-t p-4 text-sm md:max-h-none md:w-80 md:shrink-0 md:border-t-0 md:border-l">
          {node ? (
            <StepInspector node={node} graph={graph} names={names} spaces={spaces} categories={categories} categoriesError={categoriesError} busy={busy}
              onChange={(next) => setGraph(updateStep(graph, next))} onConnect={onConnect} onRemove={remove} onClose={() => setSelected(null)} />
          ) : <p className="text-xs text-muted-foreground">Select a step to change it. Drag from a step’s right edge to the next one to connect them; a check leads on by Yes and by No.</p>}

          {problems.length || !draft.name.trim() ? (
            <section aria-label="What still needs doing" className="space-y-1 rounded-lg border border-destructive/40 p-3">
              <h3 className="text-xs font-medium text-destructive">Before you can save</h3>
              <ul className="list-disc space-y-0.5 pl-4 text-xs">
                {!draft.name.trim() ? <li>Give the flow a name.</li> : null}
                {general.map((p) => <li key={p.message}>{p.message}</li>)}
                {problems.filter((p) => p.node).map((p) => (
                  <li key={`${p.node}:${p.message}`}><button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => setSelected(p.node!)}>{p.message}</button></li>
                ))}
              </ul>
            </section>
          ) : null}

          {graphAsksModel(graph) ? <p className="text-xs text-muted-foreground">Questions for the AI send the first part of each document that reaches them to a model, once per version: each costs a model call.</p> : null}
          {copiesWithoutApproval(graph, new Set(spaces.filter((s) => s.a3doc).map((s) => s.slug))) ? <p className="text-xs text-muted-foreground">Copies into an a3doc space go on to a3doc, which can’t delete them. Add a “Wait for approval” step before a copy until the flow does what you expect.</p> : null}

          <MatchPreview draft={draft} previewKey={key} preview={preview} fresh={fresh} names={names} busy={busy} onPreview={setPreview}
            runExisting={canRunExisting ? runExisting === key : null} onRunExisting={(on) => setRunExisting(on ? key : null)}
            scheduledNew={!draft.id && trigger?.on === 'schedule'} />
        </aside>
      </div>}
    </form>
  );
}

/**
 * Which documents already in the watched spaces the flow would reach, checked on request against
 * the graph as it stands (the runner's own matching), with the choice to run on them when saving.
 */
function MatchPreview({ draft, previewKey, preview, fresh, names, busy, onPreview, runExisting, onRunExisting, scheduledNew }: {
  draft: Draft; previewKey: string; preview: { key: string; result: FlowPreview } | null; fresh: FlowPreview | null; names: Names; busy: boolean;
  onPreview: (p: { key: string; result: FlowPreview }) => void;
  /** Null when this flow can't be run on what is there (it is off, or a new scheduled flow's first run covers it). */
  runExisting: boolean | null; onRunExisting: (on: boolean) => void; scheduledNew: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);
  useEffect(() => () => { ticket.current++; }, []);
  const check = async () => {
    const mine = ++ticket.current;
    const key = previewKey;
    setLoading(true); setError(null);
    try {
      const result = await previewFlow({ id: draft.id, graph: draft.graph });
      if (ticket.current === mine) onPreview({ key, result });
    } catch (e) { if (ticket.current === mine) setError(message(e, 'Could not check the documents there.')); }
    finally { if (ticket.current === mine) setLoading(false); }
  };
  const stale = Boolean(preview) && !fresh;
  const handled = fresh?.matches.filter((m) => m.handled).length ?? 0;
  const waits = draft.graph.nodes.some((n) => n.type === 'approval');

  return (
    <section aria-label="Documents it matches now" className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">Documents already there</h3>
        <Button type="button" size="sm" variant="outline" disabled={busy || loading} onClick={() => void check()}>
          {loading ? 'Checking…' : preview ? 'Check again' : 'Show what it matches'}
        </Button>
      </div>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {stale ? <p className="text-xs text-muted-foreground">The flow changed since the last check.</p> : null}
      {fresh ? (
        <div className="space-y-2">
          <p role="status">
            {fresh.matched === 0 ? 'No documents there match.' : `${fresh.matched} ${fresh.matched === 1 ? 'document matches' : 'documents match'}${fresh.truncated ? ` among the first ${fresh.scanned}` : ''}.`}
            {fresh.uncertain ? <span className="text-muted-foreground"> {fresh.uncertain === fresh.matched ? 'Each' : fresh.uncertain} still depends on the AI question.</span> : null}
          </p>
          {fresh.matched ? <p className="text-xs text-muted-foreground">The numbers on each step say how many get there.</p> : null}
          {fresh.matches.length ? (
            <ul aria-label="Matching documents" className="max-h-56 divide-y overflow-y-auto rounded border">
              {fresh.matches.map((m) => (
                <li key={`${m.space}:${m.fileId}`} className="flex items-center justify-between gap-2 px-2 py-1.5">
                  <span className="min-w-0">
                    <span className="block truncate">{m.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{names.space(m.space)} › {folderLabel(m.folderPath)}{m.category ? ` · ${names.category(m.category)}` : ''}</span>
                  </span>
                  {m.handled ? <span className="shrink-0 text-xs text-muted-foreground">Already done</span>
                    : m.needsAnswer ? <span className="shrink-0 text-xs text-muted-foreground">If AI says yes</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {fresh.matched > fresh.matches.length ? <p className="text-xs text-muted-foreground">Showing the first {fresh.matches.length}.</p> : null}
          {fresh.matched > 0 && runExisting !== null ? (
            <label className="flex items-start gap-2">
              <Checkbox checked={runExisting} disabled={busy} onCheckedChange={(on) => onRunExisting(on === true)} />
              <span>Also run it on these when I save{waits ? ', asking me where it waits for approval' : ''}.
                {handled ? <span className="block text-xs text-muted-foreground">The ones it already did are skipped.</span> : null}</span>
            </label>
          ) : null}
        </div>
      ) : null}
      {scheduledNew ? <p className="text-xs text-muted-foreground">A scheduled flow’s first run covers the documents already there.</p> : null}
      {!draft.enabled ? <p className="text-xs text-muted-foreground">This flow is off, so saving it runs nothing.</p> : null}
    </section>
  );
}
