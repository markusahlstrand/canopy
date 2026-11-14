import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Icon, Input } from '@canopy/ui';
import {
  decideDelivery, deleteFlow, flowDeliveries, listFlows, listFoldersPage, listSites, previewFlow, ROOT_FOLDER_ID, runFlow, saveFlow,
  type FlowAction, type FlowPreview, type FlowCondition, type FlowDefinition, type FlowDelivery, type Site, type StoredFlow,
} from './api';
import type { SpaceCategory } from '../../src/space-settings';

type Draft = { id?: string; name: string; enabled: boolean; definition: FlowDefinition };
type FolderOption = { id: string; path: string };

const newDraft = (): Draft => ({
  name: '', enabled: true,
  definition: { trigger: { on: 'arrived' }, conditions: [], actions: [{ type: 'copy', space: '', folderId: '', alsoIn: [] }], mode: 'ask', versions: 'first' },
});

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message || fallback : String(e));

/** Every folder of a space, by path, as the caller sees it there: what a copy can go into. */
export async function foldersOf(slug: string, limit = 300): Promise<FolderOption[]> {
  const out: FolderOption[] = [{ id: ROOT_FOLDER_ID, path: '' }];
  const queue = [{ id: ROOT_FOLDER_ID, path: '' }];
  while (queue.length && out.length < limit) {
    const parent = queue.shift()!;
    let next: string | null = null;
    do {
      const page = await listFoldersPage(parent.id, next, slug);
      for (const f of page.entries) {
        const option = { id: f.id, path: parent.path ? `${parent.path}/${f.name}` : f.name };
        out.push(option); queue.push(option);
      }
      next = page.next;
    } while (next && out.length < limit);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const folderLabel = (path: string) => path || 'Top level';

/** One line about what a flow does, for the list. */
export function describeFlow(d: FlowDefinition, categories: readonly SpaceCategory[], sites: readonly Site[]): string {
  const when = d.trigger.on === 'arrived' ? 'When a document arrives' : d.trigger.on === 'classified' ? 'When a document is categorised' : `Every ${d.trigger.every}`;
  const ifs = d.conditions.map((c) => {
    switch (c.field) {
      case 'folder': return `${c.op === 'is' ? 'in' : 'under'} ${folderLabel(c.path)}`;
      case 'name': return `name ${c.op === 'contains' ? 'contains' : 'matches'} “${c.value}”`;
      case 'extension': return c.values.map((v) => `.${v.replace(/^\./, '')}`).join('/');
      case 'category': return c.values.map((id) => categories.find((x) => x.id === id)?.name ?? id).join(' or ');
      case 'label': return `labelled “${c.value}”`;
      case 'ask': return `AI says yes to “${c.question}”`;
    }
  });
  const then = d.actions.map((a) => a.type === 'label' ? `label “${a.value}”` : `copy to ${sites.find((s) => s.slug === a.space)?.name ?? a.space}`);
  return `${when}${ifs.length ? ` (${ifs.join(', ')})` : ''}: ${then.join(', ')}${d.mode === 'ask' ? ', after you approve' : ''}.`;
}

const STATE_TEXT: Record<FlowDelivery['state'], string> = {
  proposed: 'Waiting for you', approved: 'Approved', running: 'Running', done: 'Done', failed: 'Failed', dismissed: 'Dismissed', skipped: 'Skipped',
};

/** The space's flows: list, edit, run on existing files, and decide what they propose. */
export function FlowsDialog({ open, onOpenChange, categories }: { open: boolean; onOpenChange: (open: boolean) => void; categories: SpaceCategory[] }) {
  const [flows, setFlows] = useState<StoredFlow[] | null>(null);
  const [deliveries, setDeliveries] = useState<FlowDelivery[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  const load = async () => {
    const ticket = ++generation.current;
    try {
      const [f, d, s] = await Promise.all([listFlows(), flowDeliveries({ limit: 50 }), listSites()]);
      if (generation.current !== ticket) return;
      setFlows(f); setDeliveries(d); setSites(s); setError(null);
    } catch (e) { if (generation.current === ticket) setError(message(e, 'Could not load flows.')); }
  };
  useEffect(() => {
    if (!open) return;
    setEditing(null); setNotice(null); setFlows(null);
    void load();
    return () => { generation.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const act = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true); setError(null); setNotice(null);
    try { await work(); if (done) setNotice(done); await load(); } catch (e) { setError(message(e, 'That did not work.')); } finally { setBusy(false); }
  };

  const flowName = (id: string) => flows?.find((f) => f.id === id)?.name ?? 'A deleted flow';
  const proposals = deliveries.filter((d) => d.state === 'proposed');
  const history = deliveries.filter((d) => d.state !== 'proposed');

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[640px]">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle>{editing ? (editing.id ? 'Edit flow' : 'New flow') : 'Flows'}</DialogTitle>
          <DialogDescription>{editing ? 'When something happens, and the document matches, do this.' : 'Rules this space runs on the documents that arrive in it. Each one acts as the person who saved it.'}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4 text-sm">
          {error ? <p role="alert" className="text-destructive">{error}</p> : null}
          {notice ? <p role="status" className="text-muted-foreground">{notice}</p> : null}
          {editing ? (
            <FlowEditor draft={editing} categories={categories} sites={sites} busy={busy}
              onCancel={() => setEditing(null)}
              onSave={(draft, runExisting) => void act(async () => {
                const saved = await saveFlow(draft);
                if (runExisting) await runFlow(saved.id);
                setEditing(null);
              }, !runExisting ? 'Flow saved.' : draft.definition.mode === 'ask'
                ? 'Flow saved. What it matches here shows up under “Waiting for you” in a moment.'
                : 'Flow saved, and running on the documents already here.')} />
          ) : !flows ? <p role="status" className="text-muted-foreground">Loading flows…</p> : (
            <>
              {proposals.length ? (
                <section aria-label="Waiting for approval" className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground">Waiting for you</h3>
                  <ul className="space-y-2">
                    {proposals.map((d) => (
                      <li key={`${d.flowId}:${d.fileId}:${d.versionId}`} className="flex items-center justify-between gap-2 rounded-lg border p-2">
                        <span className="min-w-0"><span className="block truncate font-medium">{d.fileName ?? 'A file'}</span><span className="block text-xs text-muted-foreground">{flowName(d.flowId)}</span></span>
                        <span className="flex shrink-0 gap-1">
                          <Button type="button" size="sm" disabled={busy} onClick={() => void act(() => decideDelivery(d, 'approve'), 'Approved. It runs in a moment.')}>Approve</Button>
                          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => decideDelivery(d, 'dismiss'))}>Dismiss</Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <section aria-label="Flows" className="space-y-2">
                {flows.length ? <ul className="space-y-2">
                  {flows.map((f) => (
                    <li key={f.id} className="space-y-1 rounded-lg border p-3">
                      <div className="flex items-start justify-between gap-2">
                        <label className="flex min-w-0 items-start gap-2">
                          <Checkbox aria-label={`${f.name} is on`} checked={f.enabled} disabled={busy}
                            onCheckedChange={(on) => void act(() => saveFlow({ id: f.id, name: f.name, enabled: on === true, definition: f.definition }))} />
                          <span className="min-w-0"><span className="block font-medium">{f.name}</span>
                            <span className="block text-xs text-muted-foreground">{describeFlow(f.definition, categories, sites)}</span></span>
                        </label>
                        <span className="flex shrink-0 gap-1">
                          <Button type="button" size="sm" variant="ghost" aria-label={`Edit ${f.name}`} disabled={busy} onClick={() => setEditing({ id: f.id, name: f.name, enabled: f.enabled, definition: f.definition })}><Icon name="edit" size={14} /></Button>
                          <Button type="button" size="sm" variant="ghost" aria-label={`Delete ${f.name}`} disabled={busy} onClick={() => { if (window.confirm(`Delete the flow “${f.name}”? What it already did stays.`)) void act(() => deleteFlow(f.id), 'Flow deleted.'); }}><Icon name="trash" size={14} /></Button>
                        </span>
                      </div>
                      {f.pausedReason ? <p role="alert" className="text-xs text-destructive">{f.pausedReason} Save the flow again to start it.</p> : null}
                      {f.enabled && f.definition.trigger.on !== 'schedule' ? (
                        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void act(() => runFlow(f.id), `“${f.name}” is looking at the documents already here.`)}>Run on documents already here</Button>
                      ) : null}
                    </li>
                  ))}
                </ul> : <p className="text-muted-foreground">No flows yet.</p>}
                <Button type="button" variant="outline" disabled={busy} onClick={() => setEditing(newDraft())}><Icon name="plus" size={14} /> New flow</Button>
              </section>
              {history.length ? (
                <section aria-label="Recent activity" className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground">Recent activity</h3>
                  <ul className="divide-y rounded-lg border">
                    {history.map((d) => (
                      <li key={`${d.flowId}:${d.fileId}:${d.versionId}`} className="flex items-center justify-between gap-2 p-2">
                        <span className="min-w-0">
                          <span className="block truncate">{d.fileName ?? 'A file'} · <span className={d.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>{STATE_TEXT[d.state]}</span></span>
                          <span className="block truncate text-xs text-muted-foreground">{flowName(d.flowId)}{typeof d.detail.error === 'string' ? `: ${d.detail.error}` : typeof d.detail.reason === 'string' ? `: ${d.detail.reason}` : ''}</span>
                        </span>
                        {d.state === 'failed' ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void act(() => decideDelivery(d, 'retry'), 'Trying again.')}>Retry</Button> : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const CONDITION_KINDS: { field: FlowCondition['field']; label: string }[] = [
  { field: 'folder', label: 'Folder' }, { field: 'name', label: 'File name' }, { field: 'extension', label: 'File type' },
  { field: 'category', label: 'Category' }, { field: 'label', label: 'Label' }, { field: 'ask', label: 'Ask AI' },
];

function blankCondition(field: FlowCondition['field'], categories: readonly SpaceCategory[]): FlowCondition {
  switch (field) {
    case 'folder': return { field, op: 'under', path: '' };
    case 'name': return { field, op: 'contains', value: '' };
    case 'extension': return { field, values: ['pdf'] };
    case 'category': return { field, values: categories[0] ? [categories[0].id] : [], minConfidence: 0.7 };
    case 'label': return { field, value: '' };
    case 'ask': return { field, question: '' };
  }
}

/** One flow, as a form: When, If (every condition), Then, and how. */
export function FlowEditor({ draft: initial, categories, sites, busy, onSave, onCancel }: {
  draft: Draft; categories: readonly SpaceCategory[]; sites: readonly Site[]; busy: boolean; onSave: (draft: Draft, runExisting: boolean) => void; onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [runExisting, setRunExisting] = useState(false);
  const d = draft.definition;
  const setDef = (patch: Partial<FlowDefinition>) => setDraft({ ...draft, definition: { ...d, ...patch } });
  const setCondition = (i: number, c: FlowCondition) => setDef({ conditions: d.conditions.map((x, j) => (j === i ? c : x)) });
  const setAction = (i: number, a: FlowAction) => setDef({ actions: d.actions.map((x, j) => (j === i ? a : x)) });
  // Running on what is here is a backfill: a scheduled flow's first run already covers it, and a flow that is off acts on nothing.
  const canRunExisting = draft.enabled && (d.trigger.on !== 'schedule' || Boolean(draft.id));
  const incomplete = !draft.name.trim() || d.actions.some((a) => a.type === 'copy' ? !a.space || !a.folderId : !a.value.trim())
    || d.conditions.some((c) => (c.field === 'name' || c.field === 'label') ? !c.value.trim() : c.field === 'ask' ? c.question.trim().length < 3 : c.field === 'category' || c.field === 'extension' ? !c.values.length : false);

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!incomplete) onSave(draft, runExisting && canRunExisting); }}>
      <label className="block space-y-1"><span className="text-xs font-medium text-muted-foreground">Name</span>
        <Input value={draft.name} maxLength={100} placeholder="Statements to the gestoría" disabled={busy} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>

      <fieldset className="space-y-1"><legend className="text-xs font-medium text-muted-foreground">When</legend>
        <div className="flex flex-wrap gap-2">
          <select aria-label="When" className="rounded border bg-background p-1.5" disabled={busy} value={d.trigger.on}
            onChange={(e) => setDef({ trigger: e.target.value === 'schedule' ? { on: 'schedule', every: 'day' } : { on: e.target.value as 'arrived' | 'classified' } })}>
            <option value="arrived">A document arrives (uploaded, synced or mailed in)</option>
            <option value="classified">Document AI puts a document in a category</option>
            <option value="schedule">On a schedule, for what arrived since the last run</option>
          </select>
          {d.trigger.on === 'schedule' ? (
            <select aria-label="How often" className="rounded border bg-background p-1.5" disabled={busy} value={d.trigger.every}
              onChange={(e) => setDef({ trigger: { on: 'schedule', every: e.target.value as 'hour' | 'day' | 'week' | 'month' } })}>
              <option value="hour">Every hour</option><option value="day">Every day</option><option value="week">Every week</option><option value="month">Every month</option>
            </select>
          ) : null}
        </div>
      </fieldset>

      <fieldset className="space-y-2"><legend className="text-xs font-medium text-muted-foreground">If (every condition holds)</legend>
        {d.conditions.map((c, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border p-2">
            <select aria-label={`Condition ${i + 1}`} className="rounded border bg-background p-1.5" disabled={busy} value={c.field}
              onChange={(e) => setCondition(i, blankCondition(e.target.value as FlowCondition['field'], categories))}>
              {CONDITION_KINDS.map((k) => <option key={k.field} value={k.field}>{k.label}</option>)}
            </select>
            <ConditionFields condition={c} categories={categories} busy={busy} onChange={(next) => setCondition(i, next)} />
            <Button type="button" variant="ghost" size="sm" aria-label={`Remove condition ${i + 1}`} disabled={busy} onClick={() => setDef({ conditions: d.conditions.filter((_, j) => j !== i) })}><Icon name="x" size={14} /></Button>
          </div>
        ))}
        {d.conditions.some((c) => c.field === 'ask') ? <p className="text-xs text-muted-foreground">An AI question sends the first part of each matching document to a model, once per version.</p> : null}
        <Button type="button" variant="outline" size="sm" disabled={busy || d.conditions.length >= 10} onClick={() => setDef({ conditions: [...d.conditions, blankCondition('folder', categories)] })}><Icon name="plus" size={14} /> Add condition</Button>
      </fieldset>

      <fieldset className="space-y-2"><legend className="text-xs font-medium text-muted-foreground">Then</legend>
        {d.actions.map((a, i) => (
          <div key={i} className="space-y-2 rounded-lg border p-2">
            <div className="flex items-center gap-2">
              <select aria-label={`Action ${i + 1}`} className="rounded border bg-background p-1.5" disabled={busy} value={a.type}
                onChange={(e) => setAction(i, e.target.value === 'label' ? { type: 'label', value: '' } : { type: 'copy', space: '', folderId: '', alsoIn: [] })}>
                <option value="copy">Copy it to a folder</option><option value="label">Add a label</option>
              </select>
              {d.actions.length > 1 ? <Button type="button" variant="ghost" size="sm" aria-label={`Remove action ${i + 1}`} disabled={busy} onClick={() => setDef({ actions: d.actions.filter((_, j) => j !== i) })}><Icon name="x" size={14} /></Button> : null}
            </div>
            {a.type === 'label'
              ? <Input aria-label="Label to add" value={a.value} maxLength={100} disabled={busy} onChange={(e) => setAction(i, { ...a, value: e.target.value })} />
              : <CopyTarget action={a} sites={sites} busy={busy} onChange={(next) => setAction(i, next)} />}
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" disabled={busy || d.actions.length >= 5} onClick={() => setDef({ actions: [...d.actions, { type: 'label', value: '' }] })}><Icon name="plus" size={14} /> Add action</Button>
      </fieldset>

      <fieldset className="space-y-1"><legend className="text-xs font-medium text-muted-foreground">How</legend>
        <label className="flex items-center gap-2"><input type="radio" name="flow-mode" checked={d.mode === 'ask'} disabled={busy} onChange={() => setDef({ mode: 'ask' })} /> Ask me before acting on each document</label>
        <label className="flex items-center gap-2"><input type="radio" name="flow-mode" checked={d.mode === 'auto'} disabled={busy} onChange={() => setDef({ mode: 'auto' })} /> Act automatically</label>
        <label className="flex items-center gap-2 pt-1"><Checkbox checked={d.versions === 'every'} disabled={busy} onCheckedChange={(on) => setDef({ versions: on === true ? 'every' : 'first' })} /> Act again when a document gets a new version</label>
        {d.mode === 'auto' && d.actions.some((a) => a.type === 'copy') ? <p className="text-xs text-muted-foreground">Copies into an a3doc space go on to a3doc, which can't delete. Start with “Ask me” until the flow does what you expect.</p> : null}
      </fieldset>

      <MatchPreview draft={draft} categories={categories} busy={busy}
        runExisting={canRunExisting ? runExisting : null} onRunExisting={setRunExisting} />

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={busy || incomplete}>{busy ? 'Saving…' : 'Save flow'}</Button>
      </div>
    </form>
  );
}

/**
 * Which documents already here the flow would act on, checked on request against the conditions
 * as they stand (the same matching the runner uses), with the choice to run on them when saving.
 */
function MatchPreview({ draft, categories, busy, runExisting, onRunExisting }: {
  draft: Draft; categories: readonly SpaceCategory[]; busy: boolean;
  /** Null when this flow can't be run on what is here (it is off, or a new scheduled flow's first run covers it). */
  runExisting: boolean | null; onRunExisting: (on: boolean) => void;
}) {
  const d = draft.definition;
  const key = JSON.stringify([d.conditions, d.versions]);
  const [preview, setPreview] = useState<{ key: string; result: FlowPreview } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);
  const check = async () => {
    const mine = ++ticket.current;
    setLoading(true); setError(null);
    try {
      const result = await previewFlow({ id: draft.id, definition: d });
      if (ticket.current === mine) setPreview({ key, result });
    } catch (e) { if (ticket.current === mine) setError(message(e, 'Could not check the documents here.')); }
    finally { if (ticket.current === mine) setLoading(false); }
  };
  useEffect(() => () => { ticket.current++; }, []);
  const fresh = preview?.key === key ? preview.result : null;
  const stale = Boolean(preview) && !fresh;
  const categoryName = (id: string) => categories.find((c) => c.id === id)?.name ?? id;
  const handled = fresh?.matches.filter((m) => m.handled).length ?? 0;

  return (
    <section aria-label="Documents it matches now" className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">Documents already here</h3>
        <Button type="button" size="sm" variant="outline" disabled={busy || loading} onClick={() => void check()}>
          {loading ? 'Checking…' : preview ? 'Check again' : 'Show what it matches'}
        </Button>
      </div>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {stale ? <p className="text-xs text-muted-foreground">The conditions changed since the last check.</p> : null}
      {fresh ? (
        <div className="space-y-2">
          <p role="status">
            {fresh.matched === 0 ? 'No documents here match.' : `${fresh.matched} ${fresh.matched === 1 ? 'document matches' : 'documents match'}${fresh.truncated ? ` among the first ${fresh.scanned}` : ''}.`}
            {fresh.uncertain ? <span className="text-muted-foreground"> {fresh.uncertain === fresh.matched ? 'Each' : fresh.uncertain} still depends on the AI question.</span> : null}
          </p>
          {fresh.matches.length ? (
            <ul aria-label="Matching documents" className="max-h-48 divide-y overflow-y-auto rounded border">
              {fresh.matches.map((m) => (
                <li key={m.fileId} className="flex items-center justify-between gap-2 px-2 py-1.5">
                  <span className="min-w-0">
                    <span className="block truncate">{m.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{m.folderPath || 'Top level'}{m.category ? ` · ${categoryName(m.category)}` : ''}</span>
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
              <span>Also run it on these when I save{d.mode === 'ask' ? ', asking me about each' : ''}.
                {handled ? <span className="block text-xs text-muted-foreground">The ones it already did are skipped.</span> : null}</span>
            </label>
          ) : null}
        </div>
      ) : null}
      {!draft.id && d.trigger.on === 'schedule' ? <p className="text-xs text-muted-foreground">A scheduled flow’s first run covers the documents already here.</p> : null}
      {!draft.enabled ? <p className="text-xs text-muted-foreground">This flow is off, so saving it runs nothing.</p> : null}
    </section>
  );
}

function ConditionFields({ condition: c, categories, busy, onChange }: { condition: FlowCondition; categories: readonly SpaceCategory[]; busy: boolean; onChange: (c: FlowCondition) => void }) {
  const select = 'rounded border bg-background p-1.5';
  switch (c.field) {
    case 'folder':
      return <>
        <select aria-label="Folder match" className={select} disabled={busy} value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as 'is' | 'under' })}>
          <option value="under">is in or under</option><option value="is">is exactly</option>
        </select>
        <Input aria-label="Folder path" className="w-48" placeholder="Statements (empty: top level)" value={c.path} disabled={busy} onChange={(e) => onChange({ ...c, path: e.target.value })} />
      </>;
    case 'name':
      return <>
        <select aria-label="Name match" className={select} disabled={busy} value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as 'contains' | 'matches' })}>
          <option value="contains">contains</option><option value="matches">matches (* and ?)</option>
        </select>
        <Input aria-label="Name text" className="w-48" value={c.value} disabled={busy} onChange={(e) => onChange({ ...c, value: e.target.value })} />
      </>;
    case 'extension':
      return <Input aria-label="File types" className="w-48" placeholder="pdf, xml" value={c.values.join(', ')} disabled={busy}
        onChange={(e) => onChange({ ...c, values: e.target.value.split(',').map((v) => v.trim().replace(/^\./, '')).filter(Boolean) })} />;
    case 'category':
      return categories.length ? <span className="flex flex-wrap items-center gap-2">
        {categories.map((cat) => (
          <label key={cat.id} className="flex items-center gap-1"><Checkbox checked={c.values.includes(cat.id)} disabled={busy}
            onCheckedChange={(on) => onChange({ ...c, values: on === true ? [...c.values, cat.id] : c.values.filter((v) => v !== cat.id) })} />{cat.name}</label>
        ))}
        <label className="flex items-center gap-1 text-xs text-muted-foreground">AI at least
          <Input aria-label="Minimum confidence" type="number" min={0} max={100} className="w-16" value={Math.round(c.minConfidence * 100)} disabled={busy}
            onChange={(e) => onChange({ ...c, minConfidence: Math.min(100, Math.max(0, Number(e.target.value) || 0)) / 100 })} />% sure</label>
      </span> : <span className="text-xs text-muted-foreground">Add categories in Document AI settings first.</span>;
    case 'label':
      return <Input aria-label="Label" className="w-48" value={c.value} disabled={busy} onChange={(e) => onChange({ ...c, value: e.target.value })} />;
    case 'ask':
      return <Input aria-label="Question for the AI" className="min-w-64 flex-1" placeholder="Is this a monthly bank statement?" value={c.question} maxLength={300} disabled={busy} onChange={(e) => onChange({ ...c, question: e.target.value })} />;
  }
}

/** Where a copy goes: a space this person can add to, a folder there, and (for a3doc) more categories. */
function CopyTarget({ action, sites, busy, onChange }: { action: Extract<FlowAction, { type: 'copy' }>; sites: readonly Site[]; busy: boolean; onChange: (a: Extract<FlowAction, { type: 'copy' }>) => void }) {
  const [folders, setFolders] = useState<FolderOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setFolders(null); setError(null);
    if (!action.space) return;
    let live = true;
    foldersOf(action.space).then((f) => { if (live) setFolders(f); }).catch((e) => { if (live) setError(message(e, 'Could not list that space’s folders.')); });
    return () => { live = false; };
  }, [action.space]);
  const select = 'w-full rounded border bg-background p-1.5';
  return (
    <div className="space-y-2">
      <select aria-label="Space to copy to" className={select} disabled={busy} value={action.space} onChange={(e) => onChange({ ...action, space: e.target.value, folderId: '', alsoIn: [] })}>
        <option value="">Choose a space…</option>
        {sites.map((s) => <option key={s.slug} value={s.slug}>{s.name}{s.current ? ' (this space)' : ''}</option>)}
      </select>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {action.space && !folders && !error ? <p role="status" className="text-xs text-muted-foreground">Loading folders…</p> : null}
      {folders ? <>
        <select aria-label="Folder to copy to" className={select} disabled={busy} value={action.folderId} onChange={(e) => onChange({ ...action, folderId: e.target.value })}>
          <option value="">Choose a folder…</option>
          {folders.map((f) => <option key={f.id} value={f.id}>{folderLabel(f.path)}</option>)}
        </select>
        {action.folderId && folders.length > 2 ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Also file it in (a3doc categories){action.alsoIn.length ? `: ${action.alsoIn.length}` : ''}</summary>
            <div className="mt-1 max-h-40 space-y-1 overflow-y-auto">
              {folders.filter((f) => f.id !== action.folderId && f.id !== ROOT_FOLDER_ID).map((f) => (
                <label key={f.id} className="flex items-center gap-2"><Checkbox checked={action.alsoIn.includes(f.id)} disabled={busy || (!action.alsoIn.includes(f.id) && action.alsoIn.length >= 10)}
                  onCheckedChange={(on) => onChange({ ...action, alsoIn: on === true ? [...action.alsoIn, f.id] : action.alsoIn.filter((x) => x !== f.id) })} />{f.path}</label>
              ))}
            </div>
          </details>
        ) : null}
      </> : null}
    </div>
  );
}
