/**
 * The processing list: what the space is working on in the background, and how it ended.
 *
 * "Reprocess" and "Label with AI" answer at once and do the work later, so without this a
 * person who asked has no way to tell whether it is still going or done. A topbar button shows
 * how much is under way (spinning while anything is), and opens a panel listing each run by
 * its file: queued, being worked on, waiting for the text or a cooldown, retrying, done — with
 * how it ended — or failed, with why.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, cn } from '@canopy/ui';
import { getProcessing, type ProcessingList, type ProcessingRun } from './api';
import { checkedAgo } from './folder-freshness';
import { FileIcon } from './file-icon';
import { useNarrow } from './file-list';
import { kindOf } from './items';

/** How often the list is read while something is under way, or the panel is open. */
export const PROCESSING_ACTIVE_POLL_MS = 3_000;
/** …and otherwise: often enough that work queued elsewhere (an upload, a flow) shows up. */
export const PROCESSING_IDLE_POLL_MS = 60_000;

export const RUN_TITLE: Record<ProcessingRun['kind'], string> = {
  text: 'Reading the text',
  label: 'Document AI',
  entities: 'People and companies',
  flow: 'Flow',
  'flow-backfill': 'Flow over existing files',
};

/** How a finished run ended, by the outcome its job recorded. */
const OUTCOME: Record<string, string> = {
  labelled: 'Labelled and described',
  extracted: 'Read',
  proposed: 'Waiting for approval',
  'not-matching': 'Did not match the flow',
  'skipped:no-text': 'Skipped: there is no text to read',
  'skipped:not-extracted': 'Skipped: its text could not be read',
  'skipped:nothing-new': 'Nothing new to add',
  'skipped:already-read': 'Already read',
  'skipped:kept-changing': 'Skipped: the file kept changing',
  'skipped:disabled': 'Skipped: turned off in this space',
  'skipped:no-model': 'Skipped: no model is available here',
  'skipped:read-only': 'Skipped: you can’t change this file',
  'skipped:gone': 'Skipped: the file is gone',
};

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Where a run is, in one line. */
export function runStatus(run: ProcessingRun): string {
  switch (run.state) {
    case 'queued': return 'Queued';
    case 'running': return 'Working on it…';
    case 'waiting':
      if (run.waitingFor === 'text') return 'Waiting for its text to be read';
      if (run.waitingFor === 'cooldown') return run.nextAttemptAt ? `Waiting out its daily limit, until ${clock(run.nextAttemptAt)}` : 'Waiting out its daily limit';
      return run.nextAttemptAt ? `Starts at ${clock(run.nextAttemptAt)}` : 'Waiting';
    case 'retrying': {
      const when = run.nextAttemptAt ? ` at ${clock(run.nextAttemptAt)}` : '';
      return `Trying again${when}${run.error ? ` — ${run.error}` : ''}`;
    }
    case 'done': return (run.outcome && OUTCOME[run.outcome]) || 'Done';
    case 'failed': return `Failed${run.error ? `: ${run.error}` : ''}`;
  }
}

export const isActive = (run: ProcessingRun) => run.state !== 'done' && run.state !== 'failed';

/**
 * The space's processing list, kept fresh: read at once when `enabled` turns on, the space
 * changes or `nudge` moves (something was just queued), then every few seconds while
 * anything is under way or the panel is `open`, and once a minute otherwise.
 */
export function useProcessing({ enabled, space, nudge, open }: { enabled: boolean; space: string | null; nudge: number; open: boolean }) {
  const [list, setList] = useState<ProcessingList | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A read started for another space, or before the latest nudge, must not land.
  const seq = useRef(0);
  // Reads still waiting for an answer. A tick skips while one is, so a server slower than the
  // interval still lands each answer instead of every tick superseding the read before it.
  const pending = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    pending.current++;
    try {
      const next = await getProcessing();
      // An answer without the list (a worker from before this route) is no list, not an empty one.
      if (!Array.isArray(next?.runs)) throw new Error('the server didn’t send the list');
      if (mine === seq.current) { setList(next); setError(null); }
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      pending.current--;
    }
  }, []);

  useEffect(() => {
    if (!enabled) { seq.current++; setList(null); return; }
    void load();
  }, [enabled, space, nudge, load]);

  const busy = (list?.active ?? 0) > 0;
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => { if (!document.hidden && !pending.current) void load(); }, busy || open ? PROCESSING_ACTIVE_POLL_MS : PROCESSING_IDLE_POLL_MS);
    return () => window.clearInterval(id);
  }, [enabled, busy, open, load]);

  return { list, error, reload: load };
}

/** The topbar's button: spins with a count while anything is under way. */
export function ProcessingButton({ active, onClick }: { active: number; onClick: () => void }) {
  const label = active ? `Processing: ${active} in progress` : 'Processing';
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label}
      className="relative grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent">
      <Icon name={active ? 'loader' : 'activity'} size={18} className={cn(active && 'animate-spin text-primary')} />
      {active ? <span aria-hidden className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] font-semibold leading-4 text-primary-foreground">
        {active > 99 ? '99+' : active}
      </span> : null}
    </button>
  );
}

function RunRow({ run, now, onOpenFile }: { run: ProcessingRun; now: number; onOpenFile?: (fileId: string) => void }) {
  const name = run.file?.name ?? 'Every file in the space';
  const when = isActive(run) ? `Started ${checkedAgo(run.startedAt, now)}` : `Finished ${checkedAgo(run.endedAt ?? run.updatedAt, now)}`;
  const tone = run.state === 'failed' ? 'text-destructive' : run.state === 'retrying' ? 'text-amber-600 dark:text-amber-400' : run.state === 'running' ? 'text-primary' : 'text-muted-foreground';
  const icon = run.state === 'running' ? 'loader' : run.state === 'done' ? 'circle-check' : run.state === 'failed' ? 'circle-x' : run.state === 'retrying' ? 'alert-triangle' : 'timer';
  return (
    <li className="flex items-start gap-3 px-4 py-2.5" data-state={run.state}>
      <FileIcon kind={kindOf(null, run.file?.name)} size={28} />
      <div className="min-w-0 flex-1">
        {run.file && onOpenFile ? (
          <button type="button" className="block max-w-full truncate text-left text-sm font-medium hover:underline" onClick={() => onOpenFile(run.file!.id)}>{name}</button>
        ) : <span className="block truncate text-sm font-medium">{name}</span>}
        <p className="text-xs text-muted-foreground">{RUN_TITLE[run.kind]}{run.manual ? ' · asked for' : ''} · {when}</p>
        <p className={cn('mt-0.5 flex items-start gap-1 text-xs', tone)}>
          <Icon name={icon} size={13} className={cn('mt-px shrink-0', run.state === 'running' && 'animate-spin')} />
          <span className="min-w-0 break-words">{runStatus(run)}</span>
        </p>
      </div>
    </li>
  );
}

/** The panel: what is under way, then what finished lately. */
export function ProcessingPanel({ open, onOpenChange, list, error, onOpenFile }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  list: ProcessingList | null;
  error: string | null;
  onOpenFile?: (fileId: string) => void;
}) {
  const narrow = useNarrow();
  const now = Date.now();
  const active = list?.runs.filter(isActive) ?? [];
  const finished = list?.runs.filter((r) => !isActive(r)) ?? [];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side={narrow ? 'bottom' : 'right'} showCloseButton
        className={cn('gap-0 overflow-y-auto p-0', narrow ? 'max-h-[85vh] rounded-t-xl' : 'w-[min(26rem,100vw)] sm:max-w-md')}>
        <SheetHeader className="border-b">
          <SheetTitle>Processing</SheetTitle>
          <SheetDescription>Background work on this space’s files: reading their text, Document AI, people and companies, and flows.</SheetDescription>
        </SheetHeader>
        {error && !list ? <p role="alert" className="px-4 py-3 text-sm text-destructive">Couldn’t load what is being processed: {error}</p> : null}
        {!list && !error ? <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p> : null}
        {list ? <>
          {error ? <p role="alert" className="flex items-start gap-1.5 border-b px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
            <Icon name="alert-triangle" size={13} className="mt-px shrink-0" />
            <span>Couldn’t refresh, so this may be out of date: {error}</span>
          </p> : null}
          <section aria-label="In progress">
            <h3 className="px-4 pb-1 pt-3 text-xs font-medium text-muted-foreground">In progress · {active.length}</h3>
            {active.length
              ? <ul className="divide-y">{active.map((run) => <RunRow key={run.id} run={run} now={now} onOpenFile={onOpenFile} />)}</ul>
              : <p className="px-4 pb-2 text-sm text-muted-foreground">Nothing is being processed right now.</p>}
          </section>
          {finished.length ? <section aria-label="Recently finished" className="border-t">
            <h3 className="px-4 pb-1 pt-3 text-xs font-medium text-muted-foreground">Recently finished</h3>
            <ul className="divide-y">{finished.map((run) => <RunRow key={run.id} run={run} now={now} onOpenFile={onOpenFile} />)}</ul>
          </section> : null}
        </> : null}
      </SheetContent>
    </Sheet>
  );
}
