import { describe, expect, it, vi } from 'vitest';
import { substratError } from '@substrat-run/contracts';
import type { JobPassContext } from '@substrat-run/kernel';
import type { ModelHost } from '@substrat-run/vertical-host/model';
import { autoLabelJob, fenceSafe, MODEL_FAILURE, planRun, mergeDetails, parseAnalysis, type AutoLabelDeps, type AutoLabelPayload } from './document-ai';

const payload: AutoLabelPayload = { tenantId: 't', scopeId: 's', fileId: 'f1', principal: 'p' };
const attribution = { tenant: 't', scope: 's', vertical: 'drive', version: '1', operation: 'drive/auto-label' } as never;

interface World {
  description: string;
  labels: string[];
  revision: number;
  canWrite: boolean;
  status: 'pending' | 'indexed' | 'empty' | 'failed' | null;
  version: string;
  text: string;
  /** Throw this from the next update, once. */
  saveError?: unknown;
  /** Throw `not_found` from every read — the file was trashed. */
  gone?: boolean;
  /** Throw `forbidden` from every read — the uploader lost access. */
  forbidden?: boolean;
}

function harness(over: Partial<World> = {}, reply = '{"label":"Invoice","description":"An invoice from ACME Ltd for 120 EUR."}') {
  const world: World = {
    description: '', labels: [], revision: 3, canWrite: true, status: 'indexed', version: 'v1',
    text: 'ACME Ltd invoice 0042, total 120 EUR', ...over,
  };
  const saved: Record<string, unknown>[] = [];
  const invoke = async <T,>(op: string, input: Record<string, unknown>): Promise<T> => {
    if (world.gone) throw substratError('not_found', 'file not found');
    if (world.forbidden) throw substratError('forbidden', 'not allowed');
    switch (op) {
      case 'drive/file-text':
        return (world.status ? { version_id: world.version, status: world.status } : null) as T;
      case 'drive/file-details':
        return { description: world.description, labels: world.labels, revision: world.revision, canWrite: world.canWrite } as T;
      case 'drive/get-file':
        return { file: { name: 'acme-0042.pdf' } } as T;
      case 'drive/file-text-excerpt':
        return (world.status === 'indexed' ? { versionId: world.version, text: world.text, truncated: false } : null) as T;
      case 'drive/update-file-details': {
        if (world.saveError) { const e = world.saveError; world.saveError = undefined; throw e; }
        if (input.expectedVersionId !== world.version) throw substratError('conflict', 'file content changed — these details describe an older version');
        if (input.expectedRevision !== world.revision) throw substratError('conflict', 'details changed — reload before saving');
        saved.push(input);
        world.description = input.description as string;
        world.labels = input.labels as string[];
        world.revision++;
        return {} as T;
      }
    }
    throw new Error(`unexpected ${op}`);
  };
  const run = vi.fn(async () => ({ text: reply }));
  const counters: Record<string, number> = {};
  const deps: AutoLabelDeps = {
    scopeFor: async () => ({ invoke }),
    enabled: async () => true,
    model: () => ({ host: { run, status: vi.fn() } as unknown as ModelHost, spec: 'cloudflare:@cf/test', attribution }),
  };
  /** One pass with the kernel's step memo: a committed step is not run again by a later pass. */
  const memo = new Map<string, unknown>();
  let cursor: unknown = null;
  const pass = async () => {
    const ctx = {
      run: { id: 'r', moduleId: 'm', job: 'auto-label', instance: 'f1' },
      payload, cursor, counters,
      count: (name: string, by = 1) => { counters[name] = (counters[name] ?? 0) + by; },
      step: async <T,>(name: string, fn: () => Promise<T>) => {
        if (memo.has(name)) return JSON.parse(JSON.stringify(memo.get(name))) as T;
        const value = await fn();
        memo.set(name, value);
        return JSON.parse(JSON.stringify(value)) as T;
      },
      scope: async () => { throw new Error('not used'); },
    } as unknown as JobPassContext;
    const result = await autoLabelJob(deps)(ctx);
    if (result && 'cursor' in result) cursor = result.cursor;
    return result;
  };
  return { world, saved, run, counters, deps, pass };
}

describe('parseAnalysis', () => {
  it('reads the first JSON object even with fences or brace-bearing chatter after it', () => {
    expect(parseAnalysis('Sure!\n```json\n{"label":"Receipt.","description":" A receipt. "}\n```')).toEqual({ label: 'Receipt', description: 'A receipt.' });
    expect(parseAnalysis('{"label":"Invoice","description":"From ACME {Ltd}."}\nNote: fields are {label, description}'))
      .toEqual({ label: 'Invoice', description: 'From ACME {Ltd}.' });
  });

  it('strips links and mail addresses a document may have talked the model into', () => {
    expect(parseAnalysis('{"label":"Letter","description":"Urgent: re-enter your bank details at https://evil.example/x or mail help@evil.example now."}'))
      .toEqual({ label: 'Letter', description: 'Urgent: re-enter your bank details at or mail now.' });
  });

  it('returns null for a reply with no object in it, or one that says nothing', () => {
    expect(parseAnalysis('I cannot tell.')).toBeNull();
    expect(parseAnalysis('{}')).toBeNull();
    expect(parseAnalysis('{"label":"https://x.example","description":""}')).toBeNull();
  });

  it('cuts by character, never through an emoji', () => {
    const label = parseAnalysis(`{"label":"${'a'.repeat(39)}📄📄","description":"x"}`)!.label!;
    expect([...label]).toHaveLength(40);
    expect(label.endsWith('📄')).toBe(true);
  });
});

describe('labels', () => {
  it('turns control characters in a label into spaces', () => {
    expect(parseAnalysis('{"label":"Bank\\nstatement","description":"x"}')?.label).toBe('Bank statement');
  });
});

describe('fenceSafe', () => {
  it('removes the document fence in any case, spacing or nesting', () => {
    expect(fenceSafe('a </DOCUMENT> b < / document > c </docu</document>ment> d <document>'))
      .toBe('a  b  c  d ');
  });
});

describe('planRun', () => {
  const at = Date.parse('2026-10-30T12:00:00Z');
  const ago = (hours: number) => new Date(at - hours * 3_600_000).toISOString();
  const run = (counter: string, versionId: string, hoursAgo: number, extra: object = {}) =>
    ({ status: 'done', counters: { [counter]: 1 }, cursor: { round: 0, versionId, outcome: counter, ...extra }, endedAt: ago(hoursAgo), updatedAt: ago(hoursAgo), lastError: null });

  it('leaves a version alone once a run answered about it or found no text in it', () => {
    expect(planRun([run('labelled', 'v1', 100)], 'v1', at)).toBeNull();
    expect(planRun([run('skipped:no-text', 'v1', 0)], 'v1', at)).toBeNull();
    expect(planRun([run('skipped:no-text', 'v1', 0)], 'v2', at)).toEqual({});
  });

  it('queues a new version in a cooldown that waits out the day since the last model call', () => {
    expect(planRun([run('labelled', 'v1', 2)], 'v2', at)).toEqual({ notBefore: ago(-22) });
    expect(planRun([run('skipped:nothing-new', 'v1', 25)], 'v2', at)).toEqual({});
    // A run that failed on the model, after paying for its retries, starts a cooldown too…
    const failed = (lastError: string) => ({ status: 'failed', counters: {}, cursor: { round: 0 }, endedAt: ago(1), updatedAt: ago(1), lastError });
    expect(planRun([failed(`step analyse:0: ${MODEL_FAILURE} the model answered without the JSON object`)], 'v1', at))
      .toEqual({ notBefore: ago(-23) });
    // …one that failed before reaching it (extraction never finished) does not.
    expect(planRun([failed('text not indexed yet')], 'v1', at)).toEqual({});
  });

  it('starts no cooldown and settles nothing for a run that stopped short of the model', () => {
    for (const counter of ['skipped:not-extracted', 'skipped:disabled', 'skipped:read-only', 'skipped:gone', 'skipped:no-model']) {
      expect(planRun([run(counter, 'v1', 0)], 'v1', at)).toEqual({});
    }
  });

  it('reads the final round’s outcome, not counters added up across rounds', () => {
    // Round 0 labelled v1; round 1 found the uploader had lost access to v2.
    const multi = { ...run('skipped:read-only', 'v2', 1), counters: { labelled: 1, 'skipped:read-only': 1 } };
    expect(planRun([multi], 'v2', at)).toEqual({});
  });

  it('hands the run what Document AI wrote last, to replace', () => {
    const wrote = { label: 'Invoice', description: 'About v1.' };
    expect(planRun([run('labelled', 'v1', 30, { wrote }), run('skipped:nothing-new', 'v2', 26)], 'v3', at)).toEqual({ previous: wrote });
  });
});

describe('mergeDetails', () => {
  it('replaces its own earlier label and untouched description, never a person’s', () => {
    const previous = { label: 'Invoice', description: 'About v1.' };
    expect(mergeDetails({ description: 'About v1.', labels: ['tax', 'Invoice'] }, { label: 'Contract', description: 'About v2.' }, previous))
      .toMatchObject({ description: 'About v2.', labels: ['tax', 'Contract'], wrote: { label: 'Contract', description: 'About v2.' } });
    // The person rewrote the description and removed the label: both are theirs now.
    expect(mergeDetails({ description: 'Mine', labels: ['tax'] }, { label: 'Contract', description: 'About v2.' }, previous))
      .toMatchObject({ description: 'Mine', labels: ['tax', 'Contract'], wrote: { label: 'Contract', description: null } });
    // A reply with no description leaves its own in place — and still its own.
    expect(mergeDetails({ description: 'About v1.', labels: ['Invoice'] }, { label: 'Contract', description: null }, previous))
      .toMatchObject({ description: 'About v1.', labels: ['Contract'], wrote: { label: 'Contract', description: 'About v1.' } });
    // The same answer again is no change.
    expect(mergeDetails({ description: 'About v1.', labels: ['Invoice', 'tax'] }, { label: 'Invoice', description: 'About v1.' }, previous)).toBeNull();
  });

  it('adds a new label beside existing ones and describes only an empty description', () => {
    expect(mergeDetails({ description: 'Mine', labels: ['tax'] }, { label: 'Invoice', description: 'Other' }))
      .toEqual({ description: 'Mine', labels: ['tax', 'Invoice'], label: 'Invoice', described: false, wrote: { label: 'Invoice', description: null } });
  });

  it('writes nothing when the label is already there or there is no room for it', () => {
    expect(mergeDetails({ description: 'Mine', labels: ['invoice'] }, { label: 'Invoice', description: 'Other' })).toBeNull();
    const full = Array.from({ length: 20 }, (_, i) => `l${i}`);
    expect(mergeDetails({ description: 'Mine', labels: full }, { label: 'Invoice', description: null })).toBeNull();
  });
});

describe('the Document AI run', () => {
  it('fills an empty label and description, tied to the version the model read', async () => {
    const h = harness();
    expect(await h.pass()).toEqual({ done: true, cursor: { round: 0, versionId: 'v1', outcome: 'labelled', wrote: { label: 'Invoice', description: 'An invoice from ACME Ltd for 120 EUR.' } } });
    expect(h.saved).toEqual([{ fileId: 'f1', description: 'An invoice from ACME Ltd for 120 EUR.', labels: ['Invoice'], expectedRevision: 3, expectedVersionId: 'v1' }]);
    expect(h.counters).toEqual({ labelled: 1 });
  });

  it('waits for extraction by failing the pass, then labels once the text is indexed', async () => {
    const h = harness({ status: 'pending' });
    await expect(h.pass()).rejects.toThrow('not indexed yet');
    expect(h.run).not.toHaveBeenCalled();
    h.world.status = 'indexed';
    expect(await h.pass()).toMatchObject({ done: true });
    expect(h.saved).toHaveLength(1);
  });

  it('pays for the model once even when the write has to be retried', async () => {
    const h = harness({ saveError: new Error('scope unavailable') });
    await expect(h.pass()).rejects.toThrow('scope unavailable');
    await h.pass();
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.saved).toHaveLength(1);
  });

  it('recognises its own write when the pass died after it committed', async () => {
    const h = harness();
    // The write lands, then the pass dies before `apply:0` is memoised.
    const real = h.deps.scopeFor;
    let died = false;
    h.deps.scopeFor = async (p) => {
      const scope = await real(p);
      return { invoke: async <T,>(op: string, input: Record<string, unknown>) => {
        const r = await scope.invoke<T>(op, input);
        if (op === 'drive/update-file-details' && !died) { died = true; throw new Error('lease lost'); }
        return r;
      } };
    };
    await expect(h.pass()).rejects.toThrow('lease lost');
    expect(await h.pass()).toMatchObject({
      done: true,
      cursor: { outcome: 'skipped:nothing-new', wrote: { label: 'Invoice', description: 'An invoice from ACME Ltd for 120 EUR.' } },
    });
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it('marks a failed write after the answer as paid for, so it starts a cooldown', async () => {
    const h = harness({ saveError: new Error('scope unavailable') });
    await expect(h.pass()).rejects.toThrow(`${MODEL_FAILURE} answered, but the write failed: scope unavailable`);
  });

  it('merges with what a person saved while the model was running', async () => {
    const h = harness();
    h.world.saveError = substratError('conflict', 'details changed — reload before saving');
    await expect(h.pass()).rejects.toThrow('details changed');
    h.world.description = 'Paid in March';
    h.world.revision = 4;
    await h.pass();
    expect(h.saved[0]).toMatchObject({ description: 'Paid in March', labels: ['Invoice'], expectedRevision: 4 });
  });

  it('follows a version that replaced the one the model read, with a fresh round', async () => {
    const h = harness({}, '{"label":"Invoice","description":"About v2."}');
    // The write is refused because v2 landed in the gap; the retry sees it and opens round 1.
    h.world.saveError = substratError('conflict', 'file content changed');
    await expect(h.pass()).rejects.toThrow('file content changed');
    h.world.version = 'v2';
    expect(await h.pass()).toEqual({ cursor: { round: 1 } });
    expect(h.saved).toEqual([]);
    expect(await h.pass()).toMatchObject({ done: true });
    expect(h.saved).toEqual([expect.objectContaining({ expectedVersionId: 'v2', description: 'About v2.' })]);
    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.counters).toEqual({ labelled: 1 });
  });

  it('follows a file that keeps changing at once, then a cooldown apart', async () => {
    const h = harness();
    let n = 1;
    // Every version is replaced just after the model read it.
    const real = h.deps.scopeFor;
    h.deps.scopeFor = async (p) => {
      const scope = await real(p);
      return { invoke: async <T,>(op: string, input: Record<string, unknown>) => {
        if (op === 'drive/file-text-excerpt') { const r = await scope.invoke<{ versionId: string }>(op, input); h.world.version = `v${++n}`; return r as T; }
        return scope.invoke<T>(op, input);
      } };
    };
    expect(await h.pass()).toEqual({ cursor: { round: 1 } });
    expect(await h.pass()).toEqual({ cursor: { round: 2, notBefore: expect.any(String) } });
    // Round 2 waits: no reads, no model, until the day is up.
    await expect(h.pass()).rejects.toThrow('cooling down');
    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.saved).toEqual([]);
  });

  it('goes round again when a write lands after it labelled, and replaces its own label', async () => {
    const h = harness({}, '{"label":"Invoice","description":"About v1."}');
    const real = h.deps.scopeFor;
    h.deps.scopeFor = async (p) => {
      const scope = await real(p);
      return { invoke: async <T,>(op: string, input: Record<string, unknown>) => {
        const r = await scope.invoke<T>(op, input);
        // The person saves v2 the moment the label lands.
        if (op === 'drive/update-file-details' && h.world.version === 'v1') h.world.version = 'v2';
        return r;
      } };
    };
    const first = await h.pass() as { cursor: { round: number; notBefore?: string; wrote?: unknown } };
    expect(first.cursor).toMatchObject({ round: 1, wrote: { label: 'Invoice', description: 'About v1.' } });
    expect(first.cursor.notBefore).toBeUndefined();
    h.run.mockResolvedValueOnce({ text: '{"label":"Contract","description":"About v2."}' });
    expect(await h.pass()).toMatchObject({ done: true, cursor: { versionId: 'v2', wrote: { label: 'Contract' } } });
    expect(h.world).toMatchObject({ labels: ['Contract'], description: 'About v2.' });
  });

  it('follows a newer version that is still being extracted instead of calling it text-less', async () => {
    const h = harness();
    // `ready` sees v1 indexed; before `analyse` runs, v2 lands and is not indexed yet.
    const real = h.deps.scopeFor;
    let first = true;
    h.deps.scopeFor = async (p) => {
      const scope = await real(p);
      return { invoke: async <T,>(op: string, input: Record<string, unknown>) => {
        if (op === 'drive/file-details' && first) { first = false; h.world.version = 'v2'; h.world.status = 'pending'; }
        return scope.invoke<T>(op, input);
      } };
    };
    expect(await h.pass()).toEqual({ cursor: { round: 1 } });
    expect(h.run).not.toHaveBeenCalled();
    await expect(h.pass()).rejects.toThrow('not indexed yet');
    h.world.status = 'indexed';
    expect(await h.pass()).toMatchObject({ done: true });
    expect(h.saved).toEqual([expect.objectContaining({ expectedVersionId: 'v2' })]);
  });

  it('waits out a cooldown before reading anything, then describes the current version', async () => {
    const h = harness();
    const later = { ...payload, notBefore: new Date(Date.now() + 3_600_000).toISOString() };
    const job = autoLabelJob(h.deps);
    const ctx = (p: typeof later) => ({
      run: { id: 'r' }, payload: p, cursor: null, counters: {}, count: () => {},
      step: async <T,>(_: string, fn: () => Promise<T>) => fn(), scope: async () => { throw new Error('unused'); },
    }) as unknown as JobPassContext;
    await expect(job(ctx(later))).rejects.toThrow('cooling down');
    expect(h.run).not.toHaveBeenCalled();
    await expect(job(ctx({ ...later, notBefore: new Date(Date.now() - 1).toISOString() }))).resolves.toMatchObject({ done: true });
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it('never sends an encrypted .locked file to the model', async () => {
    const h = harness();
    const real = h.deps.scopeFor;
    h.deps.scopeFor = async (p) => {
      const scope = await real(p);
      return { invoke: async <T,>(op: string, input: Record<string, unknown>) =>
        op === 'drive/get-file' ? ({ file: { name: 'diary.locked' } } as T) : scope.invoke<T>(op, input) };
    };
    expect(await h.pass()).toMatchObject({ done: true, cursor: { versionId: 'v1' } });
    expect(h.run).not.toHaveBeenCalled();
    expect(h.counters).toEqual({ 'skipped:no-text': 1 });
  });

  it('does not go round again when an indexed version’s text is simply missing', async () => {
    const h = harness();
    const real = h.deps.scopeFor;
    h.deps.scopeFor = async (p) => {
      const scope = await real(p);
      return { invoke: async <T,>(op: string, input: Record<string, unknown>) =>
        op === 'drive/file-text-excerpt' ? (null as T) : scope.invoke<T>(op, input) };
    };
    expect(await h.pass()).toMatchObject({ done: true });
    expect(h.counters).toEqual({ 'skipped:not-extracted': 1 });
  });

  it('adds its label beside a person’s label and description', async () => {
    const h = harness({ description: 'Mine', labels: ['Important'] });
    await h.pass();
    expect(h.saved).toEqual([expect.objectContaining({ description: 'Mine', labels: ['Important', 'Invoice'] })]);
  });

  it('does not call the model when there is nothing it could add or nothing to read', async () => {
    for (const [over, reason] of [
      [{ canWrite: false }, 'read-only'],
      [{ status: 'empty' }, 'no-text'],
      [{ status: null }, 'not-extracted'],
      [{ status: 'failed' as World['status'] }, 'not-extracted'],
      [{ text: '   ' }, 'no-text'],
      [{ gone: true }, 'gone'],
      [{ forbidden: true }, 'read-only'],
    ] as [Partial<World>, string][]) {
      const h = harness(over);
      expect(await h.pass()).toMatchObject({ done: true });
      expect(h.run).not.toHaveBeenCalled();
      expect(h.counters).toEqual({ [`skipped:${reason}`]: 1 });
    }
  });

  it('ends as read-only when the queuing person can no longer open the space', async () => {
    const h = harness();
    h.deps.scopeFor = async () => { throw substratError('forbidden', 'not a member'); };
    expect(await h.pass()).toMatchObject({ done: true });
    expect(h.counters).toEqual({ 'skipped:read-only': 1 });
  });

  it('stops without reading anything when the space turned it off or there is no model', async () => {
    const off = harness();
    off.deps.enabled = async () => false;
    await off.pass();
    expect(off.counters).toEqual({ 'skipped:disabled': 1 });

    const none = harness();
    none.deps.model = () => null;
    await none.pass();
    expect(none.counters).toEqual({ 'skipped:no-model': 1 });
  });

  it('asks again on a reply with no usable JSON, rather than closing the file on it', async () => {
    const h = harness({}, 'no idea');
    await expect(h.pass()).rejects.toThrow(`${MODEL_FAILURE} the model answered without the JSON object`);
    expect(h.saved).toEqual([]);
    expect(h.counters).toEqual({});
  });
});
