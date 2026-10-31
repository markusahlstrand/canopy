import { expect, it } from 'vitest';
import { defineConnectors, runConnectorCall } from '@substrat-run/vertical-host/connectors';
import { attachmentRecord, connectionId, domainEvent, scopeId, tenantId, type FileSourceChange } from '@substrat-run/contracts';
import { ulid, type ScopedConnectionContext } from '@substrat-run/kernel';
import { s3ConnectorDefinition, S3_VERTICAL_PROVIDER } from '../src/vertical.js';
import { S3_FILES_EVENT, S3_ITEMS_EVENT } from '../src/files.js';
import { signRequest, EMPTY_SHA256 } from '../src/sigv4.js';
import { createS3Client } from '../src/client.js';
import { FakeS3, ENDPOINT, BUCKET, ACCESS, SECRET } from './fake-s3.js';

const JOURNAL = 'drive/source-write-journal';

function world() {
  const s3 = new FakeS3();
  const def = s3ConnectorDefinition({ journalOperation: JOURNAL });
  const state = new Map<string, unknown>(), journal = new Map<string, unknown>();
  const changes: FileSourceChange[] = [];
  /** The vertical's side: what it holds, by item id. */
  const drive = new Map<string, { path: string; content?: string }>();
  const uploads = new Map<string, string>();
  const t = tenantId.parse(ulid()), s = scopeId.parse(ulid()), id = connectionId.parse(ulid());
  const record = (rid: string, filename: string, size: number) => attachmentRecord.parse({ id: rid, entity: { entityType: 'file', entityId: 'file' }, filename, contentType: 'application/pdf', size, sha256: 'a'.repeat(64), visibility: 'internal', createdBy: 'author', createdAt: '2026-10-31T09:00:00.000Z' });
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
    invoke: async <O>(operation: string, input?: unknown) => {
      if (operation !== JOURNAL) throw new Error(`unexpected ${operation}`);
      const { key, value } = input as { key: string; value?: unknown };
      // The drive's `drive/source-write-journal` input refuses any other key.
      if (!/^(a3doc:write:|s3:moves$)/.test(key)) throw new Error(`journal key '${key}' is not one the drive accepts`);
      if (value !== undefined) journal.set(key, structuredClone(value));
      return { value: structuredClone(journal.get(key) ?? null) } as O;
    },
    attachments: {
      upload: async (input) => {
        const rid = ulid();
        const bytes = input.body instanceof Uint8Array ? input.body : await new Response(input.body.stream as ReadableStream).arrayBuffer();
        uploads.set(rid, new TextDecoder().decode(bytes));
        return { ...record(rid, input.filename, 1), entity: input.entity };
      },
      open: async (aid) => {
        const text = `bytes of ${aid}`;
        return { record: record(aid, `${aid}.pdf`, text.length), contentType: 'application/pdf', body: new TextEncoder().encode(text) };
      },
    },
  };
  const bind = async (folder = '') => { ctx.scope.options = await def.bind!(ctx, { folder }); };
  /** Sweep until the pass completes, as the platform's poll would. */
  const sweepAll = async () => { for (let i = 0; i < 50; i++) if (!(await def.sweep!(ctx))?.more) return; throw new Error('sweep never completed'); };
  /** Run a call the way the platform does: its state writes are kept only when it succeeds. */
  const call = async (fn: () => Promise<unknown>) => {
    const before = structuredClone(state);
    try { await fn(); } catch (e) { state.clear(); for (const [k, v] of before) state.set(k, v); throw e; }
  };
  const event = (type: string, payload: unknown, eid = ulid()) => domainEvent.parse({ id: eid, type, schemaVersion: 1, occurredAt: '2026-10-31T09:00:00.000Z', tenantId: t, scopeId: s, actor: ulid(), entity: { entityType: 'file', entityId: 'file' }, piiClass: 'none', payload });
  const dispatch = (e: ReturnType<typeof event>) => call(() => def.dispatch!(ctx, e));
  return { s3, def, ctx, state, journal, changes, drive, bind, sweepAll, call, event, dispatch };
}

it('signs the AWS SigV4 reference request (GET Object with Range)', async () => {
  const headers = await signRequest({
    method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', query: {}, headers: { range: 'bytes=0-9' },
    payloadHash: EMPTY_SHA256, now: new Date('2013-05-24T00:00:00Z'),
    credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1' },
  });
  expect(headers.authorization).toBe(
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
});

it('declares a vertical-owned provider routing both write events, and probes the bucket', async () => {
  const w = world();
  expect(defineConnectors({ [S3_VERTICAL_PROVIDER]: w.def }).declarations()[0]).toMatchObject({ provider: 'canopy.s3', sweeps: true, binds: true, dispatches: true });
  expect(w.def.events).toEqual([S3_FILES_EVENT, S3_ITEMS_EVENT]);
  expect(await w.def.probe(w.ctx)).toMatchObject({ ok: true, accountLabel: BUCKET });
  w.s3.deny = true;
  expect(await w.def.probe(w.ctx)).toMatchObject({ ok: false, refused: true });
  expect(await w.def.probeCandidate({ bucket: BUCKET }, { fetch: w.s3.fetch as never })).toMatchObject({ ok: false, refused: true });
});

it('a transport failure on the wire probe is inconclusive, never a refusal', async () => {
  const w = world();
  const called = () => { throw new Error('scope must not be reached by a probe'); };
  const response = await runConnectorCall({ role: 'probe-candidate', provider: S3_VERTICAL_PROVIDER, secret: w.ctx.secret }, {
    connectors: defineConnectors({ [S3_VERTICAL_PROVIDER]: w.def }), fetch: async () => { throw new Error('offline'); },
    host: { connectorInvokeLocal: called, connectorAttachmentUploadLocal: called, connectorAttachmentOpenLocal: called },
  });
  expect(response).toMatchObject({ ok: true, result: { ok: false, refused: false } });
});

it('syncs only the bound prefix, folders before their files, and lands nothing twice', async () => {
  const w = world();
  w.s3.put('photos/2026/beach.jpg', 'sand');
  w.s3.put('photos/notes.txt', 'hi');
  w.s3.put('photos/empty/', '');
  w.s3.put('photos/bad//x.txt', 'skipped');
  w.s3.put('other/secret.txt', 'outside');
  await w.bind('photos');
  await w.sweepAll();
  const upserts = w.changes.filter(c => c.change === 'upsert').map(c => `${c.kind}:${c.path}`);
  expect(upserts).toEqual(['folder:2026', 'file:2026/beach.jpg', 'folder:empty', 'file:notes.txt']);
  expect(w.drive.get('photos/2026/beach.jpg')).toEqual({ path: '2026/beach.jpg', content: 'sand' });
  const before = w.changes.length;
  await w.sweepAll();
  expect(w.changes).toHaveLength(before);
});

it('lands an edit made in the bucket as new content, and a delete only after asking about the item', async () => {
  const w = world();
  w.s3.put('a.txt', 'one'); w.s3.put('b.txt', 'two');
  await w.bind(); await w.sweepAll();
  const first = w.changes.find(c => c.change === 'content' && c.itemId === 'a.txt') as Extract<FileSourceChange, { change: 'content' }>;
  w.s3.put('a.txt', 'one, edited');
  w.s3.objects.delete('b.txt');
  w.changes.length = 0;
  await w.sweepAll();
  expect(w.changes.find(c => c.change === 'content')).toMatchObject({ itemId: 'a.txt', replaces: first.attachment.id });
  expect(w.changes.find(c => c.change === 'delete')).toMatchObject({ itemId: 'b.txt', reason: 'deleted' });
  expect(w.s3.calls.some(c => c.method === 'HEAD' && c.key === 'b.txt')).toBe(true);
  expect(w.drive.get('a.txt')?.content).toBe('one, edited');
});

it('cuts a large first sync into calls under the outbound ceiling, resuming where each stopped', async () => {
  const w = world();
  for (let i = 0; i < 120; i++) w.s3.put(`docs/f${String(i).padStart(3, '0')}.txt`, `bytes ${i}`);
  await w.bind();
  let calls = 0;
  for (;;) {
    const before = w.s3.calls.length;
    const result = await w.def.sweep!(w.ctx);
    expect(w.s3.calls.length - before).toBeLessThan(100);
    calls++;
    if (!result?.more) break;
  }
  expect(calls).toBeGreaterThan(5);
  expect(w.changes.filter(c => c.change === 'content')).toHaveLength(120);
  expect(new Set(w.changes.filter(c => c.kind === 'file' && c.change === 'upsert').map(c => c.itemId)).size).toBe(120);
});

it('uploads with each conflict mode, and a retry whose answer was lost adopts its own object', async () => {
  const w = world();
  w.s3.put('in/Report.pdf', 'theirs');
  await w.bind('in'); await w.sweepAll();
  const files = (attachmentId: string) => [{ attachmentId, name: 'Report.pdf', size: `bytes of ${attachmentId}`.length }];
  await expect(w.dispatch(w.event(S3_FILES_EVENT, { conflict: 'fail', files: files('att1') }))).rejects.toThrow('already exists');
  const rename = w.event(S3_FILES_EVENT, { conflict: 'rename', files: files('att2') });
  await w.dispatch(rename);
  await w.dispatch(rename); // redelivered: its own object, not a second copy
  expect([...w.s3.objects.keys()].sort()).toEqual(['in/Report (1).pdf', 'in/Report.pdf']);
  await w.dispatch(w.event(S3_FILES_EVENT, { conflict: 'replace', files: files('att3') }));
  expect(w.s3.text('in/Report.pdf')).toBe('bytes of att3');
});

it("adopts the vertical's own upload as content without downloading it back", async () => {
  const w = world();
  await w.bind();
  await w.dispatch(w.event(S3_FILES_EVENT, { directory: 'inbox', conflict: 'fail', files: [{ attachmentId: 'att', name: 'Scan.pdf', size: 'bytes of att'.length }] }));
  w.s3.calls.length = 0;
  await w.sweepAll();
  expect(w.changes.find(c => c.change === 'content')).toMatchObject({ itemId: 'inbox/Scan.pdf', attachment: { id: 'att' } });
  expect(w.s3.calls.filter(c => c.method === 'GET' && c.key)).toEqual([]);
});

it('moves a file and a folder keeping their item ids, makes folders, and deletes', async () => {
  const w = world();
  w.s3.put('a/one.txt', '1'); w.s3.put('a/sub/two.txt', '2'); w.s3.put('loose.txt', 'l');
  await w.bind(); await w.sweepAll();
  const idsBefore = new Set(w.drive.keys());

  await w.dispatch(w.event(S3_ITEMS_EVENT, { request: { op: 'move', kind: 'file', from: 'loose.txt', to: 'a/renamed.txt' } }));
  await w.dispatch(w.event(S3_ITEMS_EVENT, { request: { op: 'move', kind: 'folder', from: 'a', to: 'b' } }));
  expect([...w.s3.objects.keys()].sort()).toEqual(['b/one.txt', 'b/renamed.txt', 'b/sub/two.txt']);
  w.changes.length = 0;
  await w.sweepAll();
  // Same identities at their new paths: nothing was deleted and nothing new was minted.
  expect(w.changes.filter(c => c.change === 'delete')).toEqual([]);
  expect(new Set(w.drive.keys())).toEqual(idsBefore);
  expect(w.drive.get('loose.txt')?.path).toBe('b/renamed.txt');
  expect(w.drive.get('a/sub/')?.path).toBe('b/sub');

  await w.dispatch(w.event(S3_ITEMS_EVENT, { request: { op: 'mkdir', path: 'new' } }));
  await w.dispatch(w.event(S3_ITEMS_EVENT, { request: { op: 'mkdir', path: 'new' } }));
  expect(w.s3.objects.has('new/')).toBe(true);
  await w.dispatch(w.event(S3_ITEMS_EVENT, { request: { op: 'delete', items: [{ kind: 'folder', path: 'b' }] } }));
  expect([...w.s3.objects.keys()]).toEqual(['new/']);
  await expect(w.dispatch(w.event(S3_ITEMS_EVENT, { request: { op: 'move', kind: 'file', from: 'gone.txt', to: 'x.txt' } }))).rejects.toThrow('not in the bucket');
});

it('a delete made through a write leaves the vertical too, folder contents included', async () => {
  const w = world();
  w.s3.put('b/one.txt', '1'); w.s3.put('b/sub/two.txt', '2'); w.s3.put('keep.txt', 'k');
  await w.bind(); await w.sweepAll();
  await w.dispatch(w.event(S3_ITEMS_EVENT, { request: { op: 'delete', items: [{ kind: 'folder', path: 'b' }] } }));
  expect([...w.drive.keys()]).toEqual(['keep.txt']);
  await w.sweepAll();
  expect([...w.drive.keys()]).toEqual(['keep.txt']);
});

it('deletes a folder of exactly one budget in a single delivery', async () => {
  const w = world();
  for (let i = 0; i < 80; i++) w.s3.put(`full/${String(i).padStart(2, '0')}.txt`, `${i}`);
  await w.bind(); await w.sweepAll();
  await w.dispatch(w.event(S3_ITEMS_EVENT, { request: { op: 'delete', items: [{ kind: 'folder', path: 'full' }] } }));
  expect(w.s3.objects.size).toBe(0);
  expect(w.drive.size).toBe(0);
});

it('a renamed upload lands as its own item from its own bytes, and the sync completes', async () => {
  const w = world();
  w.s3.put('Report.pdf', 'theirs');
  await w.bind(); await w.sweepAll();
  await w.dispatch(w.event(S3_FILES_EVENT, { conflict: 'rename', files: [{ attachmentId: 'mine', name: 'Report.pdf', size: 'bytes of mine'.length }] }));
  await w.sweepAll();
  expect(w.drive.get('Report (1).pdf')?.content).toBe('bytes of mine');
  expect(w.drive.get('Report.pdf')?.content).toBe('theirs');
});

it('finishes a file move whose copy landed but whose delete was lost', async () => {
  const w = world();
  w.s3.put('a.txt', 'a');
  await w.bind(); await w.sweepAll();
  const move = w.event(S3_ITEMS_EVENT, { request: { op: 'move', kind: 'file', from: 'a.txt', to: 'b.txt' } });
  w.s3.faults.push((method, key) => method === 'DELETE' && key === 'a.txt');
  await expect(w.dispatch(move)).rejects.toThrow('connection reset');
  expect([...w.s3.objects.keys()].sort()).toEqual(['a.txt', 'b.txt']);
  await w.dispatch(move);
  expect([...w.s3.objects.keys()]).toEqual(['b.txt']);
  await w.sweepAll();
  expect([...w.drive]).toEqual([['a.txt', { path: 'b.txt', content: 'a' }]]);
  // Someone else's object at the target is still refused.
  w.s3.put('c.txt', 'c');
  await expect(w.dispatch(w.event(S3_ITEMS_EVENT, { request: { op: 'move', kind: 'file', from: 'b.txt', to: 'c.txt' } }))).rejects.toThrow('already exists');
});

it('re-lands held items at their new relative path when the binding widens', async () => {
  const w = world();
  w.s3.put('a/b/x.txt', 'x');
  await w.bind('a/b'); await w.sweepAll();
  expect(w.drive.get('a/b/x.txt')?.path).toBe('x.txt');
  await w.bind('a'); await w.sweepAll();
  expect(w.drive.get('a/b/x.txt')?.path).toBe('b/x.txt');
  expect(w.changes.filter(c => c.change === 'content')).toHaveLength(1);
});

it('signs the host fetch will send, without a default port', async () => {
  const now = new Date('2026-11-01T00:00:00Z');
  const credentials = { accessKeyId: ACCESS, secretAccessKey: SECRET, region: 'auto' };
  let sent: { url: string; authorization?: string } | undefined;
  const client = createS3Client({
    config: { ...credentials, bucket: BUCKET, endpoint: 'https://acct.r2.example:443' }, now: () => now,
    fetch: (async (url: string, init: { headers?: Record<string, string> }) => { sent = { url, authorization: init.headers?.authorization }; return new Response('<ListBucketResult/>'); }) as never,
  });
  await client.list({ maxKeys: 1 });
  expect(sent!.url.startsWith('https://acct.r2.example/')).toBe(true);
  const expected = await signRequest({ method: 'GET', host: 'acct.r2.example', path: `/${BUCKET}/`, query: { 'list-type': '2', 'max-keys': '1' }, headers: {}, payloadHash: EMPTY_SHA256, credentials, now });
  expect(sent!.authorization).toBe(expected.authorization);
});
