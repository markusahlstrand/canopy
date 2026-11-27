import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ATTACHMENT_TEXT_JOB, ATTACHMENT_TEXT_MODULE } from '@substrat-run/kernel';
import { mountProcessing, PROCESSING_RECENT_MAX, viewOf, type ProcessingAccess, type ProcessingList, type RunRecord } from './processing-routes';

const DRIVE = 'canopy.drive';
const NOW = Date.parse('2026-11-27T12:00:00Z');
let n = 0;

function run(o: Partial<RunRecord> & { fileId?: string }): RunRecord {
  const { fileId, ...rest } = o;
  n++;
  return {
    id: `run${n}`, moduleId: DRIVE, job: 'auto-label', instance: fileId ?? `x${n}`, status: 'running',
    payload: { fileId, principal: 'someone-else', tenantId: 't', scopeId: 's' }, cursor: null, attempts: 0, lastError: null,
    startedAt: new Date(NOW - (1000 - n) * 1000).toISOString(), updatedAt: new Date(NOW).toISOString(),
    nextAttemptAt: null, endedAt: null, leaseOwner: null, ...rest,
  };
}

function app(o: { runs: RunRecord[]; readable?: string[]; attachments?: Record<string, string>; readsSpace?: boolean }) {
  const readable = new Set(o.readable ?? []);
  const invoke = vi.fn(async (op: string, input?: Record<string, unknown>) => {
    if (op === 'drive/resolve-files') {
      const attachments = ((input!.attachmentIds as string[]) ?? [])
        .flatMap((attachmentId) => {
          const fileId = o.attachments?.[attachmentId];
          return fileId && readable.has(fileId) ? [{ attachmentId, fileId }] : [];
        });
      const ids = new Set([...((input!.fileIds as string[]) ?? []), ...attachments.map((a) => a.fileId)]);
      return { files: [...ids].filter((id) => readable.has(id)).map((id) => ({ id, name: `${id}.pdf`, folder_id: 'root' })), attachments };
    }
    if (op === 'drive/get-folder') {
      if (o.readsSpace) return { id: 'root' };
      throw new Error('forbidden');
    }
    throw new Error(`unexpected ${op}`);
  });
  const runs = vi.fn(async (filter: { status?: 'running'; limit: number }) =>
    [...o.runs].reverse().filter((r) => !filter.status || r.status === filter.status).slice(0, filter.limit));
  const access: ProcessingAccess = { scope: { invoke } as ProcessingAccess['scope'], driveModuleId: DRIVE, runs, now: () => NOW };
  const hono = new Hono();
  mountProcessing(hono, async () => access);
  const get = async () => {
    const res = await hono.request('/api/processing');
    expect(res.status).toBe(200);
    return res.json() as Promise<ProcessingList>;
  };
  return { get, invoke, runs };
}

describe('the processing list', () => {
  it('names each run by a file the caller can read, and leaves the rest out', async () => {
    const a = app({ runs: [run({ fileId: 'mine' }), run({ fileId: 'theirs' }), run({ job: 'extract-entities', fileId: 'mine', status: 'done' })], readable: ['mine'] });
    const list = await a.get();
    expect(list.runs.map((r) => [r.kind, r.file?.name, r.state])).toEqual([['label', 'mine.pdf', 'queued'], ['entities', 'mine.pdf', 'done']]);
    expect(list.active).toBe(1);
  });

  it('never sends a run’s payload: who queued it stays on the server', async () => {
    const list = await app({ runs: [run({ fileId: 'mine' })], readable: ['mine'] }).get();
    expect(JSON.stringify(list)).not.toContain('someone-else');
    expect(list.runs[0]).not.toHaveProperty('payload');
  });

  it('finds the file behind the kernel’s text extraction by its attachment', async () => {
    const text = run({ moduleId: ATTACHMENT_TEXT_MODULE, job: ATTACHMENT_TEXT_JOB, instance: 'att1', payload: {}, leaseOwner: 'pass' });
    const list = await app({ runs: [text], readable: ['doc'], attachments: { att1: 'doc' } }).get();
    expect(list.runs).toMatchObject([{ kind: 'text', state: 'running', file: { id: 'doc', name: 'doc.pdf' } }]);
  });

  it('leaves out the automation dispatcher and other modules’ jobs', async () => {
    const list = await app({ runs: [run({ job: 'automation', fileId: 'mine' }), run({ moduleId: 'other', fileId: 'mine' })], readable: ['mine'] }).get();
    expect(list.runs).toEqual([]);
  });

  it('shows a flow backfill only to someone who reads the whole space', async () => {
    const backfill = run({ job: 'flow-backfill', payload: { flowId: 'f' } });
    expect((await app({ runs: [backfill], readsSpace: false }).get()).runs).toEqual([]);
    expect((await app({ runs: [backfill], readsSpace: true }).get()).runs).toMatchObject([{ kind: 'flow-backfill', file: null }]);
  });

  it('keeps every unsettled run, however many finished after it, and caps the finished ones', async () => {
    const old = run({ fileId: 'mine', instance: 'mine#manual' });
    const done = Array.from({ length: PROCESSING_RECENT_MAX + 10 }, () => run({ fileId: 'mine', status: 'done', endedAt: new Date(NOW).toISOString() }));
    const list = await app({ runs: [old, ...done], readable: ['mine'] }).get();
    expect(list.runs[0]).toMatchObject({ id: old.id, state: 'queued', manual: true });
    expect(list.runs.filter((r) => r.state === 'done')).toHaveLength(PROCESSING_RECENT_MAX);
  });

  it('asks for no file names when nothing is running', async () => {
    const a = app({ runs: [] });
    expect(await a.get()).toEqual({ runs: [], active: 0 });
    expect(a.invoke).not.toHaveBeenCalled();
  });
});

describe('where a run is', () => {
  const at = (r: Partial<RunRecord>) => viewOf(run(r), 'label', NOW);

  it('is running while a pass holds it, and queued when due and not yet picked up', () => {
    expect(at({ leaseOwner: 'p' }).state).toBe('running');
    expect(at({}).state).toBe('queued');
  });

  it('is waiting on purpose for the text or a cooldown, not failing', () => {
    expect(at({ attempts: 2, lastError: 'text not indexed yet' })).toMatchObject({ state: 'waiting', waitingFor: 'text' });
    expect(at({ attempts: 1, lastError: 'cooling down until 2026-11-28T00:00:00Z' })).toMatchObject({ state: 'waiting', waitingFor: 'cooldown' });
    expect(at({ nextAttemptAt: new Date(NOW + 60_000).toISOString() }).state).toBe('waiting');
  });

  it('is retrying after a failed pass, with why', () => {
    expect(at({ attempts: 1, lastError: 'document-ai/model: timed out' })).toMatchObject({ state: 'retrying', error: 'document-ai/model: timed out' });
  });

  it('says how a finished run ended, and why a failed one stopped', () => {
    expect(at({ status: 'done', cursor: { outcome: 'skipped:no-text' } })).toMatchObject({ state: 'done', outcome: 'skipped:no-text' });
    expect(at({ status: 'failed', lastError: 'x'.repeat(1000) }).error).toHaveLength(300);
  });
});
