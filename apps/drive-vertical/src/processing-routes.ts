/**
 * What the space is working on in the background: `GET /api/processing`.
 *
 * A reprocess from a file's menu answers 202 and goes off the response path — reading the
 * text, Document AI, entity extraction and flows are all kernel job runs, driven later by
 * the request's own `runDueJobs`, the sweeper, or a retry after backoff. This is the read
 * that lets the person who asked see where that work is: queued, being done, waiting for
 * the text or a cooldown, retrying, done (with how it ended) or failed (with why).
 *
 * What it shows is what the caller may read. A run is named by its file, and the file is
 * looked up AS THE CALLER (`drive/resolve-files`): a run whose file they cannot read, or
 * which is in the trash, is left out, so the list never says what someone else's file is
 * called or that it exists. The run's payload — whose write queued it, model settings —
 * never leaves the server; only the fields below do.
 */
import type { Context, Env, Hono } from 'hono';
import { ATTACHMENT_TEXT_JOB, ATTACHMENT_TEXT_MODULE } from '@substrat-run/kernel';
import { ROOT_FOLDER_ID } from '@canopy/scope-drive';
import { AUTO_LABEL_JOB } from './document-ai.js';
import { EXTRACT_ENTITIES_JOB } from './entity-extraction.js';
import { FLOW_BACKFILL_JOB, FLOW_RUN_JOB } from './automation.js';

export interface ProcessingScope {
  invoke<T>(operation: string, input?: Record<string, unknown>): Promise<T>;
}

/** The fields of a kernel `JobRun` this read looks at. */
export interface RunRecord {
  id: string;
  moduleId: string;
  job: string;
  instance: string;
  status: 'running' | 'done' | 'failed';
  payload: unknown;
  cursor: unknown;
  attempts: number;
  lastError: string | null;
  startedAt: string;
  updatedAt: string;
  nextAttemptAt: string | null;
  endedAt: string | null;
  leaseOwner: string | null;
}

/** What the route reads with: the space as the caller, the scope's run records, and a clock. */
export interface ProcessingAccess {
  scope: ProcessingScope;
  /** The drive module's id: a run of another module's job is not this list's to show. */
  driveModuleId: string;
  /** The scope's runs, newest first (`ScopeHost.jobRuns`). */
  runs(filter: { status?: 'running'; limit: number }): Promise<RunRecord[]>;
  now(): number;
}

/** What a run does, in the words the list uses for it. */
export type ProcessingKind = 'text' | 'label' | 'entities' | 'flow' | 'flow-backfill';

/**
 * Where a run is. The kernel has three states, and `running` covers everything not yet
 * settled; this splits it the way a person waiting on it would:
 *  - `queued`: due, not picked up yet;
 *  - `running`: a pass holds it right now;
 *  - `waiting`: it is waiting on purpose — for the file's text to be read, or a cooldown;
 *  - `retrying`: a pass failed and the run is due again after its backoff (`error` says why).
 */
export type ProcessingState = 'queued' | 'running' | 'waiting' | 'retrying' | 'done' | 'failed';

export interface ProcessingRun {
  id: string;
  kind: ProcessingKind;
  state: ProcessingState;
  /** Asked for from a menu, rather than queued by an upload. */
  manual: boolean;
  /** The file it works on; null for a run over the whole space (a flow's backfill). */
  file: { id: string; name: string; folderId: string } | null;
  /** What `waiting` is waiting for. */
  waitingFor?: 'text' | 'cooldown';
  /** How a finished run ended, as the job recorded it (`labelled`, `skipped:no-text`, …). */
  outcome?: string;
  /** Why the last pass failed — on a `retrying` or `failed` run. */
  error?: string;
  attempts: number;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  /** When it is due again, while it waits or backs off. */
  nextAttemptAt: string | null;
}

export interface ProcessingList {
  runs: ProcessingRun[];
  /** Runs not settled yet. Every one of them is in `runs`. */
  active: number;
}

/** How many unsettled runs one read looks at, and how many finished ones it shows beside them. */
export const PROCESSING_ACTIVE_MAX = 200;
export const PROCESSING_RECENT_MAX = 30;
const ERROR_MAX = 300;
/** The most ids of each kind one `drive/resolve-files` call takes (its input schema's max). */
const RESOLVE_BATCH = 200;

function kindOf(run: RunRecord, driveModuleId: string): ProcessingKind | null {
  if (run.moduleId === ATTACHMENT_TEXT_MODULE) return run.job === ATTACHMENT_TEXT_JOB ? 'text' : null;
  if (run.moduleId !== driveModuleId) return null;
  switch (run.job) {
    case AUTO_LABEL_JOB: return 'label';
    case EXTRACT_ENTITIES_JOB: return 'entities';
    case FLOW_RUN_JOB: return 'flow';
    case FLOW_BACKFILL_JOB: return 'flow-backfill';
    // The automation dispatcher is plumbing: it hands work to the runs above.
    default: return null;
  }
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});
const stringField = (v: unknown, key: string) => (typeof record(v)[key] === 'string' ? record(v)[key] as string : undefined);

/** The waits a job does on purpose, by the error its step throws while waiting (`document-ai.ts`). */
function waitOf(error: string | null): ProcessingRun['waitingFor'] {
  if (!error) return undefined;
  if (error.includes('text not indexed yet')) return 'text';
  if (error.startsWith('cooling down until')) return 'cooldown';
  return undefined;
}

/** A kernel run as the list shows it, before its file is named. Pure. */
export function viewOf(run: RunRecord, kind: ProcessingKind, now: number): Omit<ProcessingRun, 'file'> {
  const base = {
    id: run.id, kind, manual: run.instance.endsWith('#manual') || record(run.payload).manual === true,
    attempts: run.attempts, startedAt: run.startedAt, updatedAt: run.updatedAt, endedAt: run.endedAt, nextAttemptAt: run.nextAttemptAt,
  };
  const error = run.lastError ? run.lastError.slice(0, ERROR_MAX) : undefined;
  if (run.status === 'done') {
    const outcome = stringField(run.cursor, 'outcome');
    return { ...base, state: 'done', ...(outcome ? { outcome } : {}) };
  }
  if (run.status === 'failed') return { ...base, state: 'failed', ...(error ? { error } : {}) };
  if (run.leaseOwner) return { ...base, state: 'running' };
  const waitingFor = waitOf(run.lastError);
  if (waitingFor) return { ...base, state: 'waiting', waitingFor };
  if (run.attempts > 0 || error) return { ...base, state: 'retrying', ...(error ? { error } : {}) };
  // Started with a `notBefore` (a cooldown) and not yet tried: due later, on purpose.
  if (run.nextAttemptAt && Date.parse(run.nextAttemptAt) > now) return { ...base, state: 'waiting' };
  return { ...base, state: 'queued' };
}

/** The list, from the scope's runs: every unsettled run first, then the latest finished ones. */
export async function processingList(access: ProcessingAccess): Promise<ProcessingList> {
  const [active, recent] = await Promise.all([
    access.runs({ status: 'running', limit: PROCESSING_ACTIVE_MAX }),
    access.runs({ limit: PROCESSING_ACTIVE_MAX }),
  ]);
  const now = access.now();
  const seen = new Set<string>();
  // Every candidate, finished ones included: the cap on finished runs is applied after the
  // caller's files are known, so runs on files they cannot read never take a slot.
  const picked: { run: RunRecord; kind: ProcessingKind }[] = [];
  for (const run of [...active, ...recent]) {
    if (seen.has(run.id)) continue;
    seen.add(run.id);
    const kind = kindOf(run, access.driveModuleId);
    if (kind) picked.push({ run, kind });
  }

  const fileIds = new Set<string>();
  const attachmentIds = new Set<string>();
  for (const { run, kind } of picked) {
    if (kind === 'text') attachmentIds.add(run.instance);
    else if (kind !== 'flow-backfill') {
      const fileId = stringField(run.payload, 'fileId');
      if (fileId) fileIds.add(fileId);
    }
  }
  // `drive/resolve-files` takes at most RESOLVE_BATCH ids of each kind, so every id is asked about in batches.
  const fileList = [...fileIds];
  const attachmentList = [...attachmentIds];
  const batches = Math.ceil(Math.max(fileList.length, attachmentList.length) / RESOLVE_BATCH);
  const resolved = await Promise.all(Array.from({ length: batches }, (_, i) =>
    access.scope.invoke<{ files: { id: string; name: string; folder_id: string }[]; attachments: { attachmentId: string; fileId: string }[] }>(
      'drive/resolve-files', {
        fileIds: fileList.slice(i * RESOLVE_BATCH, (i + 1) * RESOLVE_BATCH),
        attachmentIds: attachmentList.slice(i * RESOLVE_BATCH, (i + 1) * RESOLVE_BATCH),
      },
    )));
  const files = new Map(resolved.flatMap((r) => r.files).map((f) => [f.id, { id: f.id, name: f.name, folderId: f.folder_id }]));
  const byAttachment = new Map(resolved.flatMap((r) => r.attachments).map((a) => [a.attachmentId, a.fileId]));
  // A run over the whole space names no file, so it is shown to those who read the space's root.
  const readsSpace = picked.some((p) => p.kind === 'flow-backfill')
    ? await access.scope.invoke('drive/get-folder', { folderId: ROOT_FOLDER_ID }).then(() => true, () => false)
    : false;

  const runs: ProcessingRun[] = [];
  let finished = 0;
  for (const { run, kind } of picked) {
    if (run.status !== 'running' && finished >= PROCESSING_RECENT_MAX) continue;
    let file: ProcessingRun['file'] = null;
    if (kind === 'flow-backfill') {
      if (!readsSpace) continue;
    } else {
      const fileId = kind === 'text' ? byAttachment.get(run.instance) : stringField(run.payload, 'fileId');
      file = (fileId && files.get(fileId)) || null;
      if (!file) continue;
    }
    if (run.status !== 'running') finished++;
    runs.push({ ...viewOf(run, kind, now), file });
  }
  const isActive = (r: ProcessingRun) => r.state !== 'done' && r.state !== 'failed';
  const at = (r: ProcessingRun) => Date.parse(isActive(r) ? r.startedAt : r.endedAt ?? r.updatedAt);
  runs.sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || at(b) - at(a));
  return { runs, active: runs.filter(isActive).length };
}

export function mountProcessing<E extends Env>(app: Hono<E>, resolve: (c: Context<E>) => Promise<ProcessingAccess>) {
  app.get('/api/processing', async (c) => {
    const list = await processingList(await resolve(c));
    c.header('cache-control', 'no-store');
    return c.json(list);
  });
}
