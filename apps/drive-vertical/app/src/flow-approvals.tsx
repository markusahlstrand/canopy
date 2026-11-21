/**
 * What flows wait on a person for: every proposal across the spaces they own, in the same
 * `<sub-entity-table>` the drive lists files in, so it sorts, selects (one, a range, all) and
 * opens the way the file list does, and its bulk bar approves or rejects a whole selection.
 *
 * The table runs a bulk action one row at a time. Run like that, 200 invoices would be 200
 * requests in a row; instead the first row's run sends the whole selection to the decide route
 * in batches, and each row's run waits only for its own answer. The table then counts and
 * summarises as it does for any bulk action, and this lists which documents were refused and why.
 *
 * On a phone a tap opens the proposal in a bottom sheet, with the same decisions.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import '@substrat-run/elements/entity-table';
import { BULK, type RowAction, type TableQuery, type TableSource } from '@substrat-run/elements/entity-table-model';
import type { Column, SubEntityTable } from '@substrat-run/elements/entity-table';
import { Button, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@canopy/ui';
import { ApiError, decideDelivery, decideDeliveries, flowDeliveries, type DeliveryView } from './api';
import { DECIDE_BATCH_LIMIT } from '../../src/flow-contract';
import { FileIcon } from './file-icon';
import { useNarrow } from './file-list';
import { kindOf } from './items';

/** How many decisions go in one request: under the route's limit, so a progress line moves often. */
export const APPROVAL_CHUNK = Math.min(20, DECIDE_BATCH_LIMIT);
/** How many proposals one look reads: the route's most. */
export const APPROVALS_LIMIT = 200;

type Decision = 'approve' | 'dismiss';
type Sort = 'name' | 'source' | 'flow' | 'arrived';
/** A proposal as a table row: the table keys rows by `id`. */
export type ApprovalRow = DeliveryView & { id: string };
type Column_ = 'name' | 'source' | 'flow' | 'destination' | 'arrived';

const keyOf = (d: DeliveryView) => `${d.space}:${d.flowId}:${d.fileId}:${d.versionId}`;
const decisionOf = (d: DeliveryView, decision: Decision) => ({ space: d.space, flowId: d.flowId, fileId: d.fileId, versionId: d.versionId, decision });
const VERB: Record<Decision, { doing: string; done: string; failed: string }> = {
  approve: { doing: 'Approving', done: 'Approved', failed: 'couldn’t be approved' },
  dismiss: { doing: 'Rejecting', done: 'Rejected', failed: 'couldn’t be rejected' },
};

/** What a decision did, or is doing, in words. */
function summary(p: Progress): string {
  const verb = VERB[p.decision];
  if (p.running) return `${verb.doing} ${p.done} of ${p.total}…`;
  const ok = p.total - p.refused.length;
  const runs = p.decision === 'approve' && ok > 0;
  if (p.total === 1 && ok === 1) return runs ? 'Approved. It runs in a moment.' : `${verb.done}.`;
  return `${verb.done} ${ok} of ${p.total}.${runs ? ' They run in a moment.' : ''}`;
}

const arrivedText = (at: string) => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
const nameOf = (d: DeliveryView) => d.fileName ?? 'A file';

function sortRows(rows: ApprovalRow[], query: Pick<TableQuery<Sort>, 'sort' | 'order'>, source: (d: DeliveryView) => string): ApprovalRow[] {
  // No sort chosen: as the route answers, the latest first.
  if (!query.sort) return rows;
  const value: Record<Sort, (d: ApprovalRow) => string> = {
    name: nameOf, source, flow: (d) => d.flowName, arrived: (d) => d.createdAt,
  };
  const read = value[query.sort];
  const sign = query.order === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => sign * read(a).localeCompare(read(b), undefined, { numeric: true, sensitivity: 'base' }));
}

/** One refused decision, as the person reads it. */
export interface Refusal { id: string; name: string; why: string }
/** A batch in flight, or the last one's outcome. */
interface Progress { decision: Decision; done: number; total: number; refused: Refusal[]; running: boolean }

/** A promise settled from outside, already marked handled: the table awaits it later, in its own order. */
function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

const refusal = (status: number, message: string) => Object.assign(new Error(message), { status });
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)) || 'That did not work.';

export function FlowApprovals({ spaceName, include, refresh, onDecided, onOpen, chunk = APPROVAL_CHUNK }: {
  spaceName: (slug: string) => string;
  /** Which proposals to show (the dialog's space filter), or all. `include.key` changes when it does. */
  include: { key: string; test: (d: DeliveryView) => boolean } | null;
  /** Changes when there may be news: the table reads the proposals again, unless a decision is running. */
  refresh: string;
  /** A decision was made: what flows did lately has changed. */
  onDecided: () => void;
  /** Open the document of a proposal, wherever it is. */
  onOpen: (d: DeliveryView) => void;
  /** Decisions per request, at most `DECIDE_BATCH_LIMIT`. */
  chunk?: number;
}) {
  const table = useRef<SubEntityTable<ApprovalRow, Sort>>(null);
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [mounted, setMounted] = useState<ReadonlyMap<string, { cell: HTMLElement; column: Column_; id: string }>>(new Map());
  const [progress, setProgress] = useState<Progress | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const narrow = useNarrow();

  const sourceText = (d: DeliveryView) => d.folderPath === undefined ? spaceName(d.space) : `${spaceName(d.space)} › ${d.folderPath || 'Top level'}`;
  // What events and reads see: the latest props, not the ones of the render that set them up.
  const latest = useRef({ include, spaceName, onDecided, onOpen, sourceText, rows, chunk });
  useLayoutEffect(() => { latest.current = { include, spaceName, onDecided, onOpen, sourceText, rows, chunk }; });
  // The next read asks the server; a re-sort alone sorts what is here.
  const stale = useRef(true);
  /**
   * The table's current bulk run, as sent: each row's answer, and the rows already handed theirs.
   * It outlives its last request (the table may still be stepping through rows); a row asked for
   * again, or one it never held, means a new bulk run.
   */
  const batch = useRef<{ decision: Decision; waiting: Map<string, ReturnType<typeof deferred>>; handed: Set<string> } | null>(null);
  const running = useRef(false);

  const source = useMemo<TableSource<ApprovalRow, Sort>>(() => ({
    read: async (query) => {
      let all = latest.current.rows;
      if (stale.current) {
        const answer = await flowDeliveries({ state: 'proposed', limit: APPROVALS_LIMIT });
        stale.current = false;
        all = answer.filter((d) => d.state === 'proposed').map((d) => ({ ...d, id: keyOf(d) }));
        latest.current.rows = all;
        setRows(all);
        setLoaded(true);
      }
      const test = latest.current.include?.test;
      const shown = test ? all.filter(test) : all;
      return { entries: sortRows(shown, query, latest.current.sourceText), next: null, total: null };
    },
    follow: () => Promise.resolve({ entries: [], next: null, total: null }),
  }), []);

  /** Send the table's selection to the route in batches; each row's run waits on its own answer. */
  const startBatch = (decision: Decision) => {
    const el = table.current!;
    const byId = new Map(latest.current.rows.map((r) => [r.id, r]));
    const chosen = [...(el.view?.selected ?? [])].flatMap((id) => byId.get(id) ?? []);
    const waiting = new Map(chosen.map((r) => [r.id, deferred()]));
    batch.current = { decision, waiting, handed: new Set() };
    running.current = true;
    setProgress({ decision, done: 0, total: chosen.length, refused: [], running: true });
    void (async () => {
      const refused: Refusal[] = [];
      let done = 0;
      const size = Math.max(1, Math.min(latest.current.chunk, DECIDE_BATCH_LIMIT));
      for (let i = 0; i < chosen.length; i += size) {
        const part = chosen.slice(i, i + size);
        let results: Awaited<ReturnType<typeof decideDeliveries>> | null = null;
        let failure: unknown = null;
        try { results = await decideDeliveries(part.map((r) => decisionOf(r, decision))); } catch (error) { failure = error; }
        part.forEach((row, j) => {
          const result = results?.[j];
          const wait = waiting.get(row.id)!;
          if (result?.ok) { wait.resolve(); return; }
          const status = result ? result.status : failure instanceof ApiError ? failure.status : 0;
          const why = result ? result.error : messageOf(failure);
          refused.push({ id: row.id, name: nameOf(row), why });
          wait.reject(refusal(status, why));
        });
        done += part.length;
        setProgress({ decision, done, total: chosen.length, refused: [...refused], running: done < chosen.length });
      }
      running.current = false;
    })();
  };

  const decide = (decision: Decision) => async (row: ApprovalRow) => {
    stale.current = true;
    if (table.current?.view?.busy === BULK) {
      const now = batch.current;
      if (!now || now.decision !== decision || !now.waiting.has(row.id) || now.handed.has(row.id)) startBatch(decision);
      const wait = batch.current?.waiting.get(row.id);
      if (wait) { batch.current!.handed.add(row.id); return wait.promise; }
    }
    setProgress(null);
    await decideDelivery(decisionOf(row, decision), decision);
    setProgress({ decision, done: 1, total: 1, refused: [], running: false });
  };

  const actions = useMemo<RowAction<ApprovalRow>[]>(() => [
    { id: 'approve', label: 'Approve', bulk: true, run: decide('approve') },
    { id: 'reject', label: 'Reject', tone: 'danger', bulk: true, run: decide('dismiss') },
    { id: 'open', label: 'Open', menu: true, run: async (row) => { latest.current.onOpen(row); } },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  const columns = useMemo<Column<ApprovalRow, Sort>[]>(() => {
    const mount = (column: Column_) => (cell: HTMLElement, row: ApprovalRow) => {
      const slot = `${column}\u0000${row.id}`;
      setMounted((m) => new Map(m).set(slot, { cell, column, id: row.id }));
      return {
        update: (next: ApprovalRow) => setMounted((m) => {
          const known = m.get(slot);
          return known && known.id === next.id ? m : new Map(m).set(slot, { cell, column, id: next.id });
        }),
        unmount: () => setMounted((m) => {
          if (!m.has(slot)) return m;
          const next = new Map(m);
          next.delete(slot);
          return next;
        }),
      };
    };
    return [
      { key: 'name', label: 'Name', value: nameOf, sort: 'name', priority: 1, mount: mount('name') },
      { key: 'source', label: 'From', value: (d) => d.space, sort: 'source', priority: 2, mount: mount('source') },
      { key: 'flow', label: 'Flow', value: (d) => d.flowName, sort: 'flow', priority: 2, mount: mount('flow') },
      { key: 'destination', label: 'Goes to', value: (d) => d.filedIn?.join(', ') ?? '', priority: 3, mount: mount('destination') },
      { key: 'arrived', label: 'Arrived', value: (d) => d.createdAt, sort: 'arrived', priority: 2, width: '150px', mount: mount('arrived') },
    ];
  }, []);

  useEffect(() => {
    const el = table.current!;
    el.columns = columns;
    el.actions = actions;
    // A selection kept across reads (a poll, a re-sort), rather than only the rows on screen.
    el.selection = [];
    el.source = source;
  }, [columns, actions, source]);

  // The dialog looked again, or its space filter changed: read again, unless a decision is running.
  const first = useRef(true);
  const filterKey = include?.key ?? '';
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const el = table.current;
    if (!el || el.view?.busy || running.current) return;
    stale.current = true;
    void el.reload();
  }, [refresh, filterKey]);

  useEffect(() => {
    const el = table.current!;
    const detail = <T,>(e: Event) => (e as CustomEvent<T>).detail;
    const on: Record<string, (e: Event) => void> = {
      'sub-row-open': (e) => latest.current.onOpen(detail<{ row: ApprovalRow }>(e).row),
      // On a phone a tap opens the proposal's sheet: there is no double-click there.
      'sub-row-click': (e) => { if (window.matchMedia?.('(max-width: 767px)').matches) { setSheetError(null); setSheet(detail<{ row: ApprovalRow }>(e).row.id); } },
      'sub-action-done': (e) => {
        const { action } = detail<{ action: string }>(e);
        if (action !== 'open') latest.current.onDecided();
      },
    };
    for (const [type, handler] of Object.entries(on)) el.addEventListener(type, handler);
    return () => { for (const [type, handler] of Object.entries(on)) el.removeEventListener(type, handler); };
  }, []);

  const byId = new Map(rows.map((r) => [r.id, r]));
  const shown = include ? rows.filter(include.test) : rows;
  const open = sheet ? byId.get(sheet) ?? null : null;

  const decideInSheet = async (row: ApprovalRow, decision: Decision) => {
    setSheetBusy(true); setSheetError(null);
    try {
      await decideDelivery(decisionOf(row, decision), decision);
      setSheet(null);
      setProgress({ decision, done: 1, total: 1, refused: [], running: false });
      stale.current = true;
      await table.current?.reload();
      latest.current.onDecided();
    } catch (error) {
      setSheetError(messageOf(error));
    } finally { setSheetBusy(false); }
  };

  const verb = progress ? VERB[progress.decision] : null;
  return (
    <section aria-label="Waiting for approval" className="space-y-2" hidden={loaded && !shown.length && !progress}>
      {shown.length ? <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">Waiting for you · {shown.length}</h3>
        {rows.length >= APPROVALS_LIMIT ? <p className="text-xs text-muted-foreground">Showing the {APPROVALS_LIMIT} latest. Decide these to see the rest.</p> : null}
      </div> : null}
      {progress && verb ? (
        <div className="space-y-1 text-sm">
          <p role="status">{summary(progress)}</p>
          {progress.running || progress.total > 1 ? (
            <progress aria-label={`${verb.doing} documents`} className="h-1.5 w-full accent-primary" max={progress.total} value={progress.done} />
          ) : null}
          {progress.refused.length ? (
            <div role="alert" className="rounded-md border border-destructive/40 p-2">
              <p className="text-destructive">{progress.refused.length} {progress.refused.length === 1 ? 'document' : 'documents'} {verb.failed}:</p>
              <ul aria-label="Not decided" className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-xs">
                {progress.refused.map((r) => <li key={r.id}><span className="font-medium">{r.name}</span> <span className="text-muted-foreground">— {r.why}</span></li>)}
              </ul>
              {!progress.running ? <Button type="button" size="xs" variant="ghost" className="mt-1" onClick={() => setProgress(null)}>Dismiss</Button> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <sub-entity-table
        ref={table as never}
        className="canopy-files"
        label="Waiting for approval"
        empty="Nothing is waiting for you."
        selectable
        paging="more"
        row-select={narrow ? undefined : true}
        row-open={narrow ? undefined : true}
        row-click
      />
      {[...mounted.entries()].map(([slot, { cell, column, id }]) => {
        const d = byId.get(id);
        if (!d) return null;
        return createPortal(
          column === 'name' ? (
            <div className="flex min-w-0 items-center gap-3">
              <FileIcon kind={kindOf(null, nameOf(d))} />
              <div className="min-w-0">
                <span className="block max-w-[calc(100vw-9rem)] truncate font-medium md:max-w-none">{nameOf(d)}</span>
                {/* Below `md` the other columns are gone: where it is from and which flow, under the name. */}
                <span className="block truncate text-xs text-muted-foreground md:hidden">{spaceName(d.space)} · {d.flowName}</span>
              </div>
            </div>
          ) : column === 'source' ? (
            <span className="block truncate text-muted-foreground" title={sourceText(d)}>{sourceText(d)}</span>
          ) : column === 'flow' ? (
            <span className="block truncate">{d.flowName}</span>
          ) : column === 'destination' ? (
            d.filedIn?.length
              ? <span className="block text-xs text-muted-foreground">{d.filedIn.map((where) => <span key={where} className="block truncate" title={where}>{where}</span>)}</span>
              : <span className="text-xs text-muted-foreground">—</span>
          ) : (
            <span className="font-mono text-[12.5px] text-muted-foreground" title={d.createdAt}>{arrivedText(d.createdAt)}</span>
          ),
          cell,
          slot,
        );
      })}
      <Sheet open={!!open} onOpenChange={(next) => { if (!next && !sheetBusy) setSheet(null); }}>
        <SheetContent side="bottom" className="max-h-[85vh] gap-0 overflow-y-auto rounded-t-xl p-0">
          {open ? <>
            <SheetHeader className="border-b">
              <SheetTitle className="flex items-center gap-2"><FileIcon kind={kindOf(null, nameOf(open))} /> <span className="min-w-0 truncate">{nameOf(open)}</span></SheetTitle>
              <SheetDescription>Waiting for you in “{open.flowName}”.</SheetDescription>
            </SheetHeader>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 p-4 text-sm">
              <dt className="text-muted-foreground">From</dt><dd className="min-w-0 [overflow-wrap:anywhere]">{sourceText(open)}</dd>
              <dt className="text-muted-foreground">Goes to</dt><dd className="min-w-0 [overflow-wrap:anywhere]">{open.filedIn?.length ? open.filedIn.map((w) => <span key={w} className="block">{w}</span>) : '—'}</dd>
              <dt className="text-muted-foreground">Arrived</dt><dd>{arrivedText(open.createdAt)}</dd>
            </dl>
            {sheetError ? <p role="alert" className="px-4 text-sm text-destructive">{sheetError}</p> : null}
            <div className="flex flex-col gap-2 p-4 pt-2">
              <Button type="button" disabled={sheetBusy} onClick={() => void decideInSheet(open, 'approve')}>Approve</Button>
              <Button type="button" variant="outline" disabled={sheetBusy} onClick={() => void decideInSheet(open, 'dismiss')}>Reject</Button>
              <Button type="button" variant="ghost" disabled={sheetBusy} onClick={() => { setSheet(null); onOpen(open); }}>Open document</Button>
            </div>
          </> : null}
        </SheetContent>
      </Sheet>
    </section>
  );
}
