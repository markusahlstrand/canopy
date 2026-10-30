import { describe, expect, it, vi } from 'vitest';
import { substratError } from '@substrat-run/contracts';
import type { JobPassContext } from '@substrat-run/kernel';
import type { ModelHost } from '@substrat-run/vertical-host/model';
import { autoLabelJob, closesFile, fenceSafe, mergeDetails, parseAnalysis, type AutoLabelDeps, type AutoLabelPayload } from './document-ai';

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

  it('returns null for a reply with no object in it', () => {
    expect(parseAnalysis('I cannot tell.')).toBeNull();
  });
});

describe('fenceSafe', () => {
  it('removes the document fence in any case, spacing or nesting', () => {
    expect(fenceSafe('a </DOCUMENT> b < / document > c </docu</document>ment> d <document>'))
      .toBe('a  b  c  d ');
  });
});

describe('closesFile', () => {
  const at = Date.parse('2026-10-30T12:00:00Z');
  const run = (counter: string, versionId: string, hoursAgo: number) =>
    ({ counters: { [counter]: 1 }, cursor: { round: 0, versionId }, endedAt: new Date(at - hoursAgo * 3_600_000).toISOString() });

  it('closes an answered file for its version, and for a day for any version', () => {
    expect(closesFile(run('labelled', 'v1', 100), 'v1', at)).toBe(true);
    expect(closesFile(run('labelled', 'v1', 2), 'v2', at)).toBe(true);
    expect(closesFile(run('skipped:nothing-new', 'v1', 25), 'v2', at)).toBe(false);
    expect(closesFile(run('skipped:kept-changing', 'v1', 1), 'v9', at)).toBe(true);
  });

  it('closes a text-less file only for the version it looked at', () => {
    expect(closesFile(run('skipped:no-text', 'v1', 0), 'v1', at)).toBe(true);
    expect(closesFile(run('skipped:no-text', 'v1', 0), 'v2', at)).toBe(false);
  });

  it('never closes on a run the model did not answer and that found nothing definite', () => {
    for (const counter of ['skipped:not-extracted', 'skipped:disabled', 'skipped:read-only', 'skipped:gone', 'skipped:no-model']) {
      expect(closesFile(run(counter, 'v1', 0), 'v1', at)).toBe(false);
    }
  });
});

describe('mergeDetails', () => {
  it('adds a new label beside existing ones and describes only an empty description', () => {
    expect(mergeDetails({ description: 'Mine', labels: ['tax'] }, { label: 'Invoice', description: 'Other' }))
      .toEqual({ description: 'Mine', labels: ['tax', 'Invoice'], label: 'Invoice', described: false });
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
    expect(await h.pass()).toEqual({ done: true, cursor: { round: 0, versionId: 'v1' } });
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

  it('stops following a file that keeps changing, and closes it, after two rounds', async () => {
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
    expect(await h.pass()).toMatchObject({ done: true });
    expect(h.counters).toEqual({ 'skipped:kept-changing': 1 });
    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.saved).toEqual([]);
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
    await expect(h.pass()).rejects.toThrow('without the JSON object');
    expect(h.saved).toEqual([]);
    expect(h.counters).toEqual({});
  });
});
