import { describe, expect, it, vi } from 'vitest';
import { substratError } from '@substrat-run/contracts';
import type { ModelHost } from '@substrat-run/vertical-host/model';
import { autoLabel, parseAnalysis, type AutoLabelScope } from './document-ai';

const attribution = { tenant: 't', scope: 's', vertical: 'drive', version: '1', operation: 'drive/auto-label' } as never;
const file = { id: 'f1', name: 'acme-0042.pdf' };

function harness(opts: { description?: string; labels?: string[]; canWrite?: boolean; text?: string | null; reply?: string; saveError?: unknown }) {
  const saved: Record<string, unknown>[] = [];
  const scope: AutoLabelScope = {
    invoke: async <T,>(op: string, input: Record<string, unknown>) => {
      if (op === 'drive/file-details') {
        return { description: opts.description ?? '', labels: opts.labels ?? [], revision: 3, canWrite: opts.canWrite ?? true } as T;
      }
      if (op === 'drive/file-text-excerpt') return (opts.text === null ? null : { versionId: 'v1', text: opts.text ?? 'ACME Ltd invoice 0042, total 120 EUR', truncated: false }) as T;
      if (op === 'drive/update-file-details') {
        if (opts.saveError) throw opts.saveError;
        saved.push(input);
        return {} as T;
      }
      throw new Error(`unexpected ${op}`);
    },
  };
  const run = vi.fn(async () => ({ text: opts.reply ?? '{"label":"Invoice","description":"An invoice from ACME Ltd for 120 EUR."}' }));
  const host = { run, status: vi.fn() } as unknown as ModelHost;
  return { scope, saved, run, model: { host, spec: 'cloudflare:@cf/test', attribution } };
}

describe('parseAnalysis', () => {
  it('reads the JSON even when the model wraps it in fences or chatter', () => {
    expect(parseAnalysis('Sure!\n```json\n{"label":"Receipt.","description":" A receipt. "}\n```')).toEqual({ label: 'Receipt', description: 'A receipt.' });
  });
  it('returns null for a reply with no object in it', () => {
    expect(parseAnalysis('I cannot tell.')).toBeNull();
  });
});

describe('autoLabel', () => {
  it('fills an empty label and description from the model', async () => {
    const h = harness({});
    expect(await autoLabel(h.scope, file, h.model)).toEqual({ status: 'labelled', label: 'Invoice', described: true });
    expect(h.saved).toEqual([{ fileId: 'f1', description: 'An invoice from ACME Ltd for 120 EUR.', labels: ['Invoice'], expectedRevision: 3 }]);
  });

  it('keeps what a person wrote and adds its label beside theirs', async () => {
    const h = harness({ description: 'Paid in March', labels: [] });
    await autoLabel(h.scope, file, h.model);
    expect(h.saved[0]).toMatchObject({ description: 'Paid in March', labels: ['Invoice'] });

    const tagged = harness({ labels: ['tax-2026'] });
    await autoLabel(tagged.scope, file, tagged.model);
    expect(tagged.saved[0]).toMatchObject({ labels: ['tax-2026', 'Invoice'] });
  });

  it('does not call the model for a file that is already described, read-only or has no text', async () => {
    for (const [opts, reason] of [
      [{ description: 'x', labels: ['y'] }, 'already-described'],
      [{ canWrite: false }, 'read-only'],
      [{ text: null }, 'no-text'],
      [{ text: '   ' }, 'no-text'],
    ] as const) {
      const h = harness(opts);
      expect(await autoLabel(h.scope, file, h.model)).toEqual({ status: 'skipped', reason });
      expect(h.run).not.toHaveBeenCalled();
    }
  });

  it('writes nothing when the model only repeats what is there', async () => {
    const h = harness({ description: 'Mine', labels: ['invoice'] , reply: '{"label":"Invoice","description":"Other"}' });
    // Both halves set → skipped before the model; with one half missing, a duplicate label is not new.
    expect((await autoLabel(h.scope, file, h.model)).status).toBe('skipped');
    const half = harness({ description: 'Mine', labels: [], reply: '{"label":"","description":"Other"}' });
    expect(await autoLabel(half.scope, file, half.model)).toEqual({ status: 'skipped', reason: 'nothing-new' });
    expect(half.saved).toEqual([]);
  });

  it('lets a person who saved meanwhile win', async () => {
    const h = harness({ saveError: substratError('conflict', 'details changed') });
    expect(await autoLabel(h.scope, file, h.model)).toEqual({ status: 'skipped', reason: 'edited-meanwhile' });
  });

  it('reports an unusable reply instead of writing it', async () => {
    const h = harness({ reply: 'no idea' });
    expect(await autoLabel(h.scope, file, h.model)).toEqual({ status: 'skipped', reason: 'unparseable' });
    expect(h.saved).toEqual([]);
  });
});
