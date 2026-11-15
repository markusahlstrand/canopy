import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { LABEL_FOLDER_MAX, mountLabel, type LabelAccess } from './label-routes';

interface Entry { id: string; name: string; labels: string[] }

function app(o: { unavailable?: string | null; canWrite?: boolean; entries?: Entry[]; fileName?: string } = {}) {
  const entries = o.entries ?? [];
  const invoke = vi.fn(async (op: string, input?: Record<string, unknown>) => {
    if (op === 'drive/get-file') return { file: { id: input!.fileId, name: o.fileName ?? 'a.pdf' }, canWrite: o.canWrite ?? true };
    if (op === 'drive/get-folder') return { id: input!.folderId, canWrite: o.canWrite ?? true };
    if (op === 'drive/list-subtree-files') {
      // Ordered by id, `after` exclusive — as the drive's listing is.
      const start = input!.after ? entries.findIndex((e) => e.id === input!.after) + 1 : 0;
      const page = entries.slice(start, start + (input!.limit as number));
      const end = start + page.length;
      return { entries: page, next: end < entries.length ? page.at(-1)!.id : null };
    }
    throw new Error(`unexpected ${op}`);
  });
  const queue = vi.fn(async (_files: readonly { id: string }[]) => {});
  const access: LabelAccess = { scope: { invoke } as LabelAccess['scope'], unavailable: async () => o.unavailable ?? null, queue };
  const hono = new Hono();
  hono.onError((err, c) => (err instanceof HTTPException ? c.json({ message: err.message }, err.status) : c.json({ message: String(err) }, 500)));
  mountLabel(hono, async () => access);
  const call = (body: unknown) => hono.request('/api/label', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { call, queue, invoke };
}

const entry = (i: number, labels: string[] = []): Entry => ({ id: `f${String(i).padStart(4, '0')}`, name: `doc-${i}.pdf`, labels });

describe('labelling on request', () => {
  it('queues one file the caller can write', async () => {
    const a = app();
    const res = await a.call({ fileId: 'f1' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: 1, skipped: 0, more: false });
    expect(a.queue).toHaveBeenCalledWith([{ id: 'f1', name: 'a.pdf' }]);
  });

  it('refuses where the space has not turned Document AI on, before reading anything', async () => {
    const a = app({ unavailable: 'Document AI is off in this space.' });
    const res = await a.call({ fileId: 'f1' });
    expect(res.status).toBe(409);
    expect(a.invoke).not.toHaveBeenCalled();
  });

  it('refuses a file the caller may only read, and an encrypted one', async () => {
    expect((await app({ canWrite: false }).call({ fileId: 'f1' })).status).toBe(403);
    const locked = app({ fileName: 'secret.pdf.locked' });
    expect((await locked.call({ fileId: 'f1' })).status).toBe(409);
    expect(locked.queue).not.toHaveBeenCalled();
  });

  it('refuses a body that names neither, or both', async () => {
    expect((await app().call({})).status).toBe(400);
    expect((await app().call({ fileId: 'a', folderId: 'b' })).status).toBe(400);
  });

  it('queues a folder’s unlabelled files, leaving labelled and encrypted ones', async () => {
    const a = app({ entries: [entry(1), entry(2, ['Invoice']), { id: 'f3', name: 'x.locked', labels: [] }, entry(4)] });
    const res = await a.call({ folderId: 'd' });
    expect(await res.json()).toEqual({ queued: 2, skipped: 2, more: false });
    expect(a.queue.mock.calls[0]![0].map((f) => f.id)).toEqual(['f0001', 'f0004']);
  });

  it('takes labelled files too when asked to relabel', async () => {
    const a = app({ entries: [entry(1), entry(2, ['Invoice'])] });
    expect(await (await a.call({ folderId: 'd', relabel: true })).json()).toEqual({ queued: 2, skipped: 0, more: false });
  });

  it('caps one request and says more are waiting', async () => {
    const a = app({ entries: Array.from({ length: LABEL_FOLDER_MAX + 700 }, (_, i) => entry(i)) });
    expect(await (await a.call({ folderId: 'd' })).json()).toEqual({ queued: LABEL_FOLDER_MAX, skipped: 0, more: true, next: entry(LABEL_FOLDER_MAX - 1).id });
  });

  it('picks up after the last file taken, so a re-label of every file gets through all of them', async () => {
    const all = Array.from({ length: LABEL_FOLDER_MAX + 1 }, (_, i) => entry(i, ['Invoice']));
    const a = app({ entries: all });
    const first = await (await a.call({ folderId: 'd', relabel: true })).json() as { next: string };
    const second = await (await a.call({ folderId: 'd', relabel: true, after: first.next })).json();
    expect(second).toEqual({ queued: 1, skipped: 0, more: false });
    expect(a.queue.mock.calls[1]![0].map((f) => f.id)).toEqual([all.at(-1)!.id]);
  });

  it('refuses a folder the caller cannot write into, and queues nothing for an empty one', async () => {
    expect((await app({ canWrite: false }).call({ folderId: 'd' })).status).toBe(403);
    const empty = app();
    expect(await (await empty.call({ folderId: 'd' })).json()).toEqual({ queued: 0, skipped: 0, more: false });
    expect(empty.queue).not.toHaveBeenCalled();
  });
});
