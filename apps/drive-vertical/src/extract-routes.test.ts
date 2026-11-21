import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { EXTRACT_FOLDER_MAX, mountExtract, type ExtractAccess } from './extract-routes';

interface Entry { id: string; name: string; current_version_id: string | null }

function app(o: { unavailable?: string | null; canWrite?: boolean; entries?: Entry[] } = {}) {
  const entries = o.entries ?? [];
  const invoke = vi.fn(async (op: string, input?: Record<string, unknown>) => {
    if (op === 'drive/get-file') return { file: { id: input!.fileId, name: 'a.pdf' }, canWrite: o.canWrite ?? true };
    if (op === 'drive/get-folder') return { id: input!.folderId, canWrite: o.canWrite ?? true };
    if (op === 'drive/list-subtree-files') {
      const start = input!.after ? entries.findIndex((e) => e.id === input!.after) + 1 : 0;
      const page = entries.slice(start, start + (input!.limit as number));
      const end = start + page.length;
      return { entries: page, next: end < entries.length ? page.at(-1)!.id : null };
    }
    throw new Error(`unexpected ${op}`);
  });
  const queue = vi.fn(async (_files: readonly { id: string }[], _manual: boolean) => {});
  const access: ExtractAccess = { scope: { invoke } as ExtractAccess['scope'], unavailable: async () => o.unavailable ?? null, queue };
  const hono = new Hono();
  hono.onError((err, c) => (err instanceof HTTPException ? c.json({ message: err.message }, err.status) : c.json({ message: String(err) }, 500)));
  mountExtract(hono, async () => access);
  const call = (body: unknown) => hono.request('/api/extract-entities', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { call, queue, invoke };
}

const entry = (i: number, version: string | null = 'v1', name = `doc-${i}.pdf`): Entry => ({ id: `f${String(i).padStart(4, '0')}`, name, current_version_id: version });

describe('entity extraction on request', () => {
  it('reads one file again, as a manual run', async () => {
    const a = app();
    const res = await a.call({ fileId: 'f1' });
    expect(res.status).toBe(202);
    expect(a.queue).toHaveBeenCalledWith([{ id: 'f1', name: 'a.pdf' }], true);
  });

  it('refuses where the space has not turned it on, and a file the caller may only read', async () => {
    const off = app({ unavailable: 'off' });
    expect((await off.call({ fileId: 'f1' })).status).toBe(409);
    expect(off.invoke).not.toHaveBeenCalled();
    expect((await app({ canWrite: false }).call({ fileId: 'f1' })).status).toBe(403);
  });

  it('queues a folder’s files as automatic runs, skipping empty and encrypted ones, and pages past the cap', async () => {
    const entries = [entry(0, null), entry(1, 'v1', 'secret.pdf.locked'), ...Array.from({ length: EXTRACT_FOLDER_MAX + 5 }, (_, i) => entry(i + 2))];
    const a = app({ entries });
    const res = await a.call({ folderId: 'd1' });
    const body = await res.json() as { queued: number; skipped: number; more: boolean; next?: string };
    expect(body).toMatchObject({ queued: EXTRACT_FOLDER_MAX, skipped: 2, more: true });
    expect(a.queue.mock.calls[0]![1]).toBe(false);
    const rest = await (await a.call({ folderId: 'd1', after: body.next })).json() as { queued: number; more: boolean };
    expect(rest).toMatchObject({ queued: 5, more: false });
  });
});
