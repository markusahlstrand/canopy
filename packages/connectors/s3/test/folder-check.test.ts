import { expect, it } from 'vitest';
import { attachmentRecord, connectionId, scopeId, tenantId, type FileSourceChange } from '@substrat-run/contracts';
import { ulid, type ScopedConnectionContext } from '@substrat-run/kernel';
import { s3ConnectorDefinition, s3FolderChecks, S3_VERTICAL_PROVIDER } from '../src/vertical.js';
import { FakeS3, ENDPOINT, BUCKET, ACCESS, SECRET } from './fake-s3.js';

const JOURNAL = 'drive/source-write-journal';

function world() {
  const s3 = new FakeS3();
  const def = s3ConnectorDefinition({ journalOperation: JOURNAL });
  const check = s3FolderChecks({ journalOperation: JOURNAL });
  const state = new Map<string, unknown>(), journal = new Map<string, unknown>();
  const changes: FileSourceChange[] = [];
  const drive = new Map<string, { path: string; content?: string }>();
  const uploads = new Map<string, string>();
  const t = tenantId.parse(ulid()), s = scopeId.parse(ulid()), id = connectionId.parse(ulid());
  const record = (rid: string, filename: string) => attachmentRecord.parse({ id: rid, entity: { entityType: 'file', entityId: 'file' }, filename, contentType: 'application/pdf', size: 1, sha256: 'a'.repeat(64), visibility: 'internal', createdBy: 'author', createdAt: '2026-10-31T09:00:00.000Z' });
  const ctx: ScopedConnectionContext = {
    connection: { id, tenantId: t, provider: S3_VERTICAL_PROVIDER, vertical: 'drive', externalAccountRef: null, expiresAt: null },
    secret: { bucket: BUCKET, accessKeyId: ACCESS, secretAccessKey: SECRET, region: 'auto', endpoint: ENDPOINT },
    fetch: s3.fetch as ScopedConnectionContext['fetch'],
    state: {
      get: async key => structuredClone(state.get(key)),
      put: async (key, value) => { if (value === null) state.delete(key); else state.set(key, structuredClone(value)); },
      list: async (prefix = '') => [...state].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })),
    },
    scope: { tenantId: t, scopeId: s, operation: 'drive/land-source-change', options: {} },
    land: async <O>(input: unknown) => {
      const c = input as FileSourceChange;
      changes.push(c);
      if (c.change === 'upsert') drive.set(c.itemId, { ...drive.get(c.itemId), path: c.path });
      if (c.change === 'content') drive.set(c.itemId, { path: c.path, content: uploads.get(c.attachment.id) ?? c.attachment.id });
      if (c.change === 'delete') drive.delete(c.itemId);
      return { entity: { entityType: 'file', entityId: c.itemId } } as O;
    },
    invoke: async <O>(_operation: string, input?: unknown) => {
      const { key, value } = input as { key: string; value?: unknown };
      if (value !== undefined) journal.set(key, structuredClone(value));
      return { value: structuredClone(journal.get(key) ?? null) } as O;
    },
    attachments: {
      upload: async (input) => {
        const rid = ulid();
        const bytes = input.body instanceof Uint8Array ? input.body : await new Response(input.body.stream as ReadableStream).arrayBuffer();
        uploads.set(rid, new TextDecoder().decode(bytes));
        return { ...record(rid, input.filename), entity: input.entity };
      },
      open: async (aid) => ({ record: record(aid, `${aid}.pdf`), contentType: 'application/pdf', body: new TextEncoder().encode(aid) }),
    },
  };
  const bind = async (folder = '') => { ctx.scope.options = await def.bind!(ctx, { folder }); };
  const sweepAll = async () => { for (let i = 0; i < 50; i++) if (!(await def.sweep!(ctx))?.more) return; throw new Error('sweep never completed'); };
  const paths = () => [...drive.values()].map(v => v.path).sort();
  return { s3, ctx, changes, drive, bind, sweepAll, paths, sweep: () => def.sweep!(ctx), check: (p: string[]) => check(ctx, p) };
}

it('lands what was added to, changed in and removed from one folder, one level deep', async () => {
  const w = world();
  w.s3.put('docs/a.txt', 'one'); w.s3.put('docs/b.txt', 'two'); w.s3.put('top.txt', 'top');
  await w.bind(); await w.sweepAll();
  w.changes.length = 0;

  w.s3.put('docs/a.txt', 'one, edited');
  w.s3.objects.delete('docs/b.txt');
  w.s3.put('docs/c.txt', 'three');
  w.s3.put('docs/deeper/d.txt', 'below the folder');
  w.s3.put('elsewhere.txt', 'not in the folder');

  expect(await w.check(['docs'])).toEqual([{ path: 'docs', changes: 4, complete: true }]);
  // The subfolder lands as a folder; what is inside it waits for a check of it, or the pass.
  expect(w.paths()).toEqual(['docs', 'docs/a.txt', 'docs/c.txt', 'docs/deeper', 'top.txt']);
  expect(w.drive.get('docs/a.txt')?.content).toBe('one, edited');
  expect(w.changes.find(c => c.change === 'delete')).toMatchObject({ itemId: 'docs/b.txt', reason: 'deleted' });
  expect(w.s3.calls.some(c => c.method === 'HEAD' && c.key === 'docs/b.txt')).toBe(true);

  const before = w.changes.length;
  expect(await w.check(['docs'])).toEqual([{ path: 'docs', changes: 0, complete: true }]);
  expect(w.changes).toHaveLength(before);
});

it('checks the bound prefix itself, and a removed subfolder after asking about it', async () => {
  const w = world();
  w.s3.put('photos/old/x.jpg', 'x'); w.s3.put('photos/keep.jpg', 'k');
  await w.bind('photos'); await w.sweepAll();
  w.s3.objects.delete('photos/old/x.jpg');
  w.s3.put('photos/new.jpg', 'n');
  const [root] = await w.check(['']);
  expect(root).toMatchObject({ path: '', complete: true });
  expect(w.paths()).toEqual(['keep.jpg', 'new.jpg', 'old/x.jpg']);
  expect(w.changes.some(c => c.change === 'delete' && c.kind === 'folder' && c.path === 'old')).toBe(true);
});

it('stops at the download budget and finishes on the next check', async () => {
  const w = world();
  await w.bind(); await w.sweepAll();
  for (let i = 0; i < 25; i++) w.s3.put(`inbox/${String(i).padStart(2, '0')}.txt`, `n${i}`);
  const [first] = await w.check(['inbox']);
  expect(first).toMatchObject({ complete: false });
  expect(w.paths().filter(p => p.startsWith('inbox/'))).toHaveLength(15);
  const [second] = await w.check(['inbox']);
  expect(second).toMatchObject({ complete: true });
  expect(w.paths().filter(p => p.startsWith('inbox/'))).toHaveLength(25);
});

it('leaves a paused pass to ask about what a folder check saw, so a later removal still lands', async () => {
  const w = world();
  for (let i = 0; i < 25; i++) w.s3.put(`f${String(i).padStart(2, '0')}.txt`, `n${i}`);
  await w.bind();
  // The first pass downloads twenty a call: it stops with five keys still unread.
  expect(await w.sweep()).toMatchObject({ more: true });
  await w.check(['']);
  expect(w.paths()).toHaveLength(25);
  w.s3.objects.delete('f24.txt');
  await w.sweepAll();
  expect(w.paths()).toHaveLength(24);
  expect(w.paths()).not.toContain('f24.txt');
});
