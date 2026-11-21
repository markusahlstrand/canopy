/**
 * The flows workspace: every flow over the spaces this person owns, what waits for them, and what
 * flows did lately — and, for one flow, the canvas to draw it on.
 *
 * Flows belong to the install, not to a space: one may watch several spaces and copy into others.
 * Opened from a space's settings, the list starts filtered to that space.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Icon, cn } from '@canopy/ui';
import {
  decideDelivery, deleteFlow, flowDeliveries, listFlows, runFlow, saveFlow,
  type DeliveryView, type FlowList, type FlowView,
} from './api';
import { confirmDiscardDrafts, useUnsavedDraft } from './drafts';
import { FlowEditor, type Draft } from './flow-editor';
import { describeFlow, newGraph, type Names } from './flow-graph-edit';
import { forgetFolders, message } from './flow-inspector';
import { FlowApprovals } from './flow-approvals';
import { openSpaceFile } from './space-navigation';

const STATE_TEXT: Record<DeliveryView['state'], string> = {
  proposed: 'Waiting for you', approved: 'Approved', running: 'Running', done: 'Done', failed: 'Failed', dismissed: 'Dismissed', skipped: 'Skipped',
};

/** How often an open flows list looks for new proposals and results. */
const FLOWS_REFRESH_MS = 10_000;

/** What a new flow watches: the space asked for (or this tab's) when the person owns it, else their only space. */
function startingSpaces(wanted: string | null, owned: readonly { slug: string }[]): string[] {
  if (wanted && owned.some((s) => s.slug === wanted)) return [wanted];
  return owned.length === 1 ? [owned[0]!.slug] : [];
}

const deliveryKey = (d: DeliveryView) => `${d.space}:${d.flowId}:${d.fileId}:${d.versionId}`;
// Just the key: `decideDelivery` sends what it is given.
const decide = (d: DeliveryView, decision: 'approve' | 'dismiss' | 'retry') =>
  decideDelivery({ space: d.space, flowId: d.flowId, fileId: d.fileId, versionId: d.versionId }, decision);

export function FlowsDialog({ open, onOpenChange, space = null, here = null, onOpenFile }: {
  open: boolean; onOpenChange: (open: boolean) => void;
  /** Start filtered to this space, and start new flows watching it. */
  space?: string | null;
  /** The space this tab is in: what a new flow watches when the list is not filtered. */
  here?: string | null;
  /** Preview a file of the space this tab is in; false when it could not (a draft kept it). */
  onOpenFile?: (fileId: string) => boolean | void;
}) {
  const [list, setList] = useState<FlowList | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryView[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [filter, setFilter] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Counts what the person changed here (a flow deleted, saved, switched on or off, a retry): each
  // can take proposals off the queue that `lately` does not cover, so the queue reads again.
  const [changes, setChanges] = useState(0);
  // A bulk decision is running in the approvals table: it stays on screen, with its results, until done.
  const [deciding, setDeciding] = useState(false);
  const locked = busy || deciding;
  const generation = useRef(0);
  useUnsavedDraft(open && Boolean(editing) && dirty);

  const load = async () => {
    const ticket = ++generation.current;
    try {
      const [l, d] = await Promise.all([listFlows(), flowDeliveries({ limit: 50 })]);
      if (generation.current !== ticket) return;
      setList(l); setDeliveries(d); setError(null);
    } catch (e) { if (generation.current === ticket) setError(message(e, 'Could not load flows.')); }
  };
  useEffect(() => {
    if (!open) return;
    setEditing(null); setNotice(null); setList(null); setFilter(space ?? ''); setDirty(false);
    forgetFolders();
    void load();
    return () => { generation.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, space]);
  // Runs finish in the background: while the list is showing, look again now and then for what they proposed or did.
  useEffect(() => {
    if (!open || editing || locked) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, FLOWS_REFRESH_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, locked]);

  const act = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true); setError(null); setNotice(null);
    try { await work(); setChanges((n) => n + 1); if (done) setNotice(done); await load(); } catch (e) { setError(message(e, 'That did not work.')); } finally { setBusy(false); }
  };

  // Names for spaces: the ones this person owns, and those flows name.
  const spaceName = useCallback((slug: string) => list?.spaces.find((s) => s.slug === slug)?.name
    ?? list?.flows.flatMap((f) => f.spaces).find((s) => s.slug === slug)?.name ?? slug, [list]);
  const names: Names = { space: spaceName, category: (id) => id, folder: () => undefined };

  const flows = list?.flows ?? [];
  const shown = filter ? flows.filter((f) => f.spaces.some((s) => s.slug === filter)) : flows;
  const shownIds = new Set(shown.map((f) => f.id));
  const relevant = filter ? deliveries.filter((d) => d.space === filter || shownIds.has(d.flowId)) : deliveries;
  const history = relevant.filter((d) => d.state !== 'proposed');
  // What flows did lately, newest first: when it changes, a proposal came or was decided, and the
  // proposals table reads again. Unchanged, it keeps what it has rather than re-reading every look.
  // `lately` is only the newest deliveries, so a change made here counts too.
  const lately = `${changes}|${deliveries.map((d) => `${deliveryKey(d)}:${d.state}:${d.updatedAt}`).join('|')}`;
  const include = filter ? { key: `${filter}|${[...shownIds].join(',')}`, test: (d: DeliveryView) => d.space === filter || shownIds.has(d.flowId) } : null;
  const filterSpaces = [...new Map([...(list?.spaces ?? []), ...flows.flatMap((f) => f.spaces)].map((s) => [s.slug, s.name])).entries()];

  const close = (next: boolean) => {
    if (locked) return;
    if (!next && editing && !confirmDiscardDrafts()) return;
    onOpenChange(next);
  };
  const edit = (f: FlowView) => setEditing({ id: f.id, name: f.name, enabled: f.enabled, graph: f.graph });
  // A document here opens in this tab's preview; one in another space opens that space on it.
  const openDocument = (d: DeliveryView) => {
    if (locked) return;
    if (d.space === here && onOpenFile) { if (onOpenFile(d.fileId) !== false) onOpenChange(false); return; }
    if (openSpaceFile(d.space, d.fileId)) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex h-[92vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1280px,96vw)]">
        <DialogHeader className="border-b px-5 pt-5 pb-3">
          <DialogTitle>{editing ? (editing.id ? 'Edit flow' : 'New flow') : 'Flows'}</DialogTitle>
          <DialogDescription>{editing
            ? 'When something happens in the spaces it watches, check the document and act on it.'
            : 'Rules that act on documents as they arrive. A flow can watch several spaces and copy into others; each acts as the person who saved it.'}</DialogDescription>
        </DialogHeader>
        {error || notice ? <div className="px-5 pt-2 text-sm">
          {error ? <p role="alert" className="text-destructive">{error}</p> : null}
          {notice ? <p role="status" className="text-muted-foreground">{notice}</p> : null}
        </div> : null}
        {editing ? (
          <FlowEditor key={editing.id ?? 'new'} draft={editing} spaces={list?.spaces ?? []} spaceName={spaceName} busy={busy}
            onDirty={setDirty}
            onCancel={() => { if (!dirty || confirmDiscardDrafts()) { setEditing(null); setDirty(false); } }}
            onSave={(draft, runExisting) => {
              const waits = draft.graph.nodes.some((n) => n.type === 'approval');
              void act(async () => {
                const saved = await saveFlow(draft);
                // Saved now: should the run fail to start, saving again updates this flow rather than making another.
                setEditing({ ...draft, id: saved.id });
                if (runExisting) await runFlow(saved.id);
                setEditing(null); setDirty(false);
              }, !runExisting ? 'Flow saved.' : waits
                ? 'Flow saved. What it matches shows up under “Waiting for you” in a moment.'
                : 'Flow saved, and running on the documents already there.');
            }} />
        ) : (
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4 text-sm">
            {!list ? (error ? null : <p role="status" className="text-muted-foreground">Loading flows…</p>) : <>
              <FlowApprovals spaceName={spaceName} include={include} refresh={lately}
                onDecided={() => void load()} onOpen={openDocument} onRunning={setDeciding} />

              <section aria-label="Flows" className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">Space
                    <select aria-label="Show flows for" className="rounded-md border bg-background p-1.5 text-sm text-foreground" value={filter} onChange={(e) => setFilter(e.target.value)}>
                      <option value="">All spaces</option>
                      {filterSpaces.map(([slug, name]) => <option key={slug} value={slug}>{name}</option>)}
                    </select></label>
                  <Button type="button" variant="outline" disabled={locked || !list.spaces.length}
                    onClick={() => setEditing({ name: '', enabled: true, graph: newGraph(startingSpaces(filter || here, list.spaces)) })}>
                    <Icon name="plus" size={14} /> New flow
                  </Button>
                </div>
                {!list.spaces.length ? <p className="text-xs text-muted-foreground">Flows act on spaces you own. You don’t own one yet.</p> : null}
                {shown.length ? <ul className="space-y-2">
                  {shown.map((f) => {
                    const trigger = f.graph.nodes.find((n) => n.type === 'trigger');
                    return (
                      <li key={f.id} className="space-y-2 rounded-lg border p-3">
                        <div className="flex items-start justify-between gap-2">
                          <label className="flex min-w-0 items-start gap-2">
                            <Checkbox aria-label={`${f.name} is on`} checked={f.enabled} disabled={locked}
                              onCheckedChange={(on) => void act(() => saveFlow({ id: f.id, name: f.name, enabled: on === true, graph: f.graph }))} />
                            <span className="min-w-0"><span className="block font-medium">{f.name}</span>
                              <span className="block text-xs text-muted-foreground">{describeFlow(f.graph, names)}</span></span>
                          </label>
                          <span className="flex shrink-0 gap-1">
                            <Button type="button" size="sm" variant="ghost" aria-label={`Edit ${f.name}`} disabled={locked} onClick={() => edit(f)}><Icon name="edit" size={14} /></Button>
                            <Button type="button" size="sm" variant="ghost" aria-label={`Delete ${f.name}`} disabled={locked}
                              onClick={() => { if (window.confirm(`Delete the flow “${f.name}”? What it already did stays.`)) void act(() => deleteFlow(f.id), 'Flow deleted.'); }}><Icon name="trash" size={14} /></Button>
                          </span>
                        </div>
                        <ul aria-label={`Spaces ${f.name} uses`} className="flex flex-wrap gap-1">
                          {f.spaces.map((s) => (
                            <li key={s.slug} className={cn('rounded-full border px-2 py-0.5 text-xs', s.slug === filter && 'border-primary')}>
                              {s.name} <span className="text-muted-foreground">· {s.watch && s.write ? 'watches, copies in' : s.watch ? 'watches' : 'copies in'}</span>
                            </li>
                          ))}
                        </ul>
                        {f.pausedReason ? <p role="alert" className="text-xs text-destructive">{f.pausedReason} Save the flow again to start it.</p>
                          : f.failures ? <p className="text-xs text-destructive">Failed {f.failures} {f.failures === 1 ? 'time' : 'times'} lately.</p> : null}
                        {f.enabled && trigger?.type === 'trigger' && trigger.on !== 'schedule' ? (
                          <Button type="button" size="sm" variant="outline" disabled={locked} onClick={() => void act(() => runFlow(f.id), `“${f.name}” is looking at the documents already there.`)}>Run on documents already there</Button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul> : <p className="text-muted-foreground">{filter && flows.length ? 'No flows use this space.' : 'No flows yet.'}</p>}
              </section>

              {history.length ? (
                <section aria-label="Recent activity" className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground">Recent activity</h3>
                  <ul className="divide-y rounded-lg border">
                    {history.map((d) => (
                      <li key={deliveryKey(d)} className="flex items-center justify-between gap-2 p-2">
                        <span className="min-w-0">
                          <span className="block truncate">{d.fileName ?? 'A file'} · <span className={d.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>{STATE_TEXT[d.state]}</span></span>
                          <span className="block truncate text-xs text-muted-foreground">{spaceName(d.space)} · {d.flowName}{typeof d.detail.error === 'string' ? `: ${d.detail.error}` : typeof d.detail.reason === 'string' ? `: ${d.detail.reason}` : ''}</span>
                        </span>
                        {d.state === 'failed' ? <Button type="button" size="sm" variant="outline" disabled={locked} onClick={() => void act(() => decide(d, 'retry'), 'Trying again.')}>Retry</Button> : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
