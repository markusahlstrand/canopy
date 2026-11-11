import { expect, it } from 'vitest';
import { defineConnectors } from '@substrat-run/vertical-host/connectors';
import { attachmentRecord, connectionId, scopeId, tenantId, type FileSourceChange } from '@substrat-run/contracts';
import { ulid, type ScopedConnectionContext } from '@substrat-run/kernel';
import { qontoConnectorDefinition, QONTO_VERTICAL_PROVIDER } from '../src/vertical.js';
import { FakeQonto, API, FILES, KEY, LOGIN } from './fake-qonto.js';

function world(start = '2026-11-09T12:00:00.000Z') {
  const q = new FakeQonto();
  const clock = { now: new Date(start) };
  const def = qontoConnectorDefinition({ apiBase: API, now: () => clock.now });
  const state = new Map<string, unknown>();
  const changes: FileSourceChange[] = [];
  const uploads: { filename: string }[] = [];
  const t = tenantId.parse(ulid()), s = scopeId.parse(ulid()), id = connectionId.parse(ulid());
  const record = attachmentRecord.parse({ id: 'upload', entity: { entityType: 'file', entityId: 'file' }, filename: 'x', contentType: 'application/pdf', size: 5, sha256: 'a'.repeat(64), visibility: 'internal', createdBy: 'author', createdAt: '2026-10-27T09:00:00.000Z' });
  const ctx: ScopedConnectionContext = {
    connection: { id, tenantId: t, provider: QONTO_VERTICAL_PROVIDER, vertical: 'drive', externalAccountRef: LOGIN, expiresAt: null },
    secret: { login: LOGIN, secretKey: KEY }, fetch: q.fetch as never,
    state: {
      get: async (key) => structuredClone(state.get(key)),
      put: async (key, value) => { if (value === null) state.delete(key); else state.set(key, structuredClone(value)); },
      list: async (prefix = '') => [...state].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })),
    },
    scope: { tenantId: t, scopeId: s, operation: 'drive/land-source-change', options: {} },
    land: async <O>(input: unknown) => { changes.push(input as FileSourceChange); return { entity: record.entity } as O; },
    invoke: async <O>(_op: string, input?: unknown) => ctx.land<O>(input),
    attachments: {
      upload: async (input) => { uploads.push({ filename: input.filename }); return { ...record, id: ulid(), entity: input.entity, filename: input.filename }; },
      open: async () => null,
    },
  };
  const files = () => changes.filter((c) => c.change === 'upsert' && c.kind === 'file').map((c) => c.path);
  return { q, def, ctx, state, changes, uploads, files, clock, sweep: () => def.sweep!(ctx) };
}

it('declares a read-only provider and connects with an API key', async () => {
  const w = world();
  const declared = defineConnectors({ [QONTO_VERTICAL_PROVIDER]: w.def }).declarations()[0];
  expect(declared).toMatchObject({ provider: 'canopy.qonto', sweeps: true, binds: true, dispatches: false });
  expect(await w.def.probe(w.ctx)).toMatchObject({ ok: true, accountRef: LOGIN, accountLabel: 'Acme SL' });
  expect(await w.def.bind!(w.ctx, {})).toEqual({ folder: '', canUpload: false, organization: 'acme' });
});

it('calls a wrong key refused and an outage inconclusive', async () => {
  const w = world();
  expect(await w.def.probeCandidate({ login: LOGIN, secretKey: 'wrong' }, { fetch: w.q.fetch as never })).toMatchObject({ ok: false, refused: true });
  w.q.status['/v2/organization'] = 500;
  expect(await w.def.probeCandidate({ login: LOGIN, secretKey: KEY }, { fetch: w.q.fetch as never })).toMatchObject({ ok: false, refused: false });
});

it('lands a transaction without a receipt as its own item', async () => {
  const w = world();
  const tx = w.q.tx({ id: '1a2b3c4d-0000-0000-0000-000000000000' });
  await w.sweep();
  const name = '2026-11-03 Adobe -59.99 EUR (1a2b3c4d).json';
  expect(w.files()).toEqual([`Transactions/2026/11/${name}`]);
  // Parents land before their children: the drive refuses an orphan.
  expect(w.changes.filter((c) => c.kind === 'folder').map((c) => c.path)).toEqual(['Transactions', 'Transactions/2026', 'Transactions/2026/11']);
  expect(w.uploads).toEqual([{ filename: name }]);
  expect(tx.id).toContain('1a2b3c4d');
});

it('lands receipts beside their transaction and never sends the key to the file host', async () => {
  const w = world();
  const a = w.q.file('Factura.PDF'), b = w.q.file('photo.jpg', 'image/jpeg');
  w.q.tx({ id: '1a2b3c4d-0000-0000-0000-000000000000', attachments: [a, b], attachment_ids: [a.id, b.id] });
  await w.sweep();
  expect(w.files()).toEqual([
    'Transactions/2026/11/2026-11-03 Adobe -59.99 EUR (1a2b3c4d).json',
    'Transactions/2026/11/2026-11-03 Adobe -59.99 EUR (1a2b3c4d).pdf',
    `Transactions/2026/11/2026-11-03 Adobe -59.99 EUR (1a2b3c4d) (${b.id.replace(/-/g, '').slice(0, 8)}).jpg`,
  ]);
  const downloads = w.q.calls.filter((c) => c.url.startsWith(FILES));
  expect(downloads).toHaveLength(2);
  expect(downloads.every((c) => c.authorization === undefined)).toBe(true);
});

it('keeps expiring URLs and logos out of the saved transaction', async () => {
  const w = world();
  const a = w.q.file();
  w.q.tx({ attachments: [a], attachment_ids: [a.id] });
  let saved = '';
  const upload = w.ctx.attachments.upload;
  (w.ctx.attachments as { upload: typeof upload }).upload = async (input) => {
    if (input.filename.endsWith('.json')) saved = new TextDecoder().decode(await new Response(input.body as never).arrayBuffer());
    return upload(input);
  };
  await w.sweep();
  expect(saved).not.toContain(FILES);
  expect(JSON.parse(saved)).toMatchObject({ attachment_ids: [a.id], amount: 59.99 });
  expect(JSON.parse(saved).logo).toBeUndefined();
});

it('lands invoices, credit notes and statements in their own folders', async () => {
  const w = world();
  const s = w.q.file('s.pdf'), c = w.q.file('c.pdf'), n = w.q.file('n.pdf');
  w.q.supplier.push({ id: '11111111-x', attachment_id: s.id, supplier_name: 'Telefónica', invoice_number: 'F/12', issue_date: '2026-10-02', updated_at: '2026-10-03T00:00:00Z' });
  w.q.client.push({ id: '22222222-x', attachment_id: c.id, number: 'INV-1', issue_date: '2026-10-05', client: { first_name: 'Ana', last_name: 'Ruiz' } });
  w.q.credit.push({ id: '33333333-x', attachment_id: n.id, number: 'CN-1', issue_date: '2026-10-06', client: { name: 'Acme' } });
  w.q.statements.push({ id: '44444444-x', bank_account_id: 'bank-1', period: '10-2026', file: { file_name: 'st.pdf', file_content_type: 'application/pdf', file_size: 9, file_url: `${FILES}/st` } });
  await w.sweep();
  expect(w.files()).toEqual([
    'Supplier invoices/2026/10/2026-10-02 Telefónica F 12 (11111111).pdf',
    'Client invoices/2026/10/2026-10-05 Ana Ruiz INV-1 (22222222).pdf',
    'Credit notes/2026/10/2026-10-06 Acme CN-1 (33333333).pdf',
    'Statements/2026/2026-10 Main (44444444).pdf',
  ]);
});

it('leaves a client invoice whose file is not generated yet, then lands it', async () => {
  const w = world();
  const row = { id: '22222222-x', number: 'INV-1', issue_date: '2026-10-05', client: { name: 'Acme' } } as Parameters<typeof w.q.client.push>[0];
  w.q.client.push(row);
  await w.sweep();
  expect(w.files()).toEqual([]);
  row.attachment_id = w.q.file().id;
  await w.sweep();
  expect(w.files()).toHaveLength(1);
});

it('lands nothing the second time, and only what changed after that', async () => {
  const w = world();
  const tx = w.q.tx();
  await w.sweep();
  const before = w.changes.length;
  await w.sweep();
  expect(w.changes).toHaveLength(before);
  const a = w.q.file();
  tx.attachments = [a]; tx.attachment_ids = [a.id]; tx.updated_at = '2026-11-04T00:00:00.000Z';
  await w.sweep();
  expect(w.files().filter((p) => p.endsWith('.pdf'))).toHaveLength(1);
});

it('keeps the first path when Qonto tidies a counterparty name', async () => {
  const w = world();
  const tx = w.q.tx({ clean_counterparty_name: 'ADOBE SYSTEMS' });
  await w.sweep();
  const first = w.files()[0];
  tx.clean_counterparty_name = 'Adobe'; tx.updated_at = '2026-11-04T00:00:00.000Z';
  await w.sweep();
  expect(w.files()).toEqual([first, first]);
});

it('deletes a receipt taken off its transaction', async () => {
  const w = world();
  const a = w.q.file();
  const tx = w.q.tx({ attachments: [a], attachment_ids: [a.id] });
  await w.sweep();
  tx.attachments = []; tx.attachment_ids = []; tx.updated_at = '2026-11-04T00:00:00.000Z';
  await w.sweep();
  expect(w.changes.filter((c) => c.change === 'delete')).toMatchObject([{ itemId: `att:${a.id}`, reason: 'deleted' }]);
});

it('finds a receipt attached without an updated_at bump on the daily re-read', async () => {
  const w = world();
  const tx = w.q.tx({ updated_at: '2026-11-03T10:00:00.000Z' });
  const later = w.q.tx({ updated_at: '2026-11-08T10:00:00.000Z' });
  await w.sweep();
  const a = w.q.file();
  tx.attachments = [a]; tx.attachment_ids = [a.id];
  w.clock.now = new Date('2026-11-09T13:00:00.000Z');
  await w.sweep();
  expect(w.files().filter((p) => p.endsWith('.pdf'))).toHaveLength(0);
  w.clock.now = new Date('2026-11-10T12:30:00.000Z');
  await w.sweep();
  expect(w.files().filter((p) => p.endsWith('.pdf'))).toHaveLength(1);
  expect(later.id).toBeTruthy();
});

it('resumes across sweeps under the outbound limit and lands everything once', async () => {
  const w = world();
  for (let i = 0; i < 130; i++) { const a = w.q.file(); w.q.tx({ attachments: [a], attachment_ids: [a.id] }); }
  const more: boolean[] = [];
  for (let i = 0; i < 4; i++) {
    const before = w.q.calls.length;
    more.push((await w.sweep())?.more ?? false);
    expect(w.q.calls.length - before).toBeLessThanOrEqual(90);
  }
  expect(more.at(-1)).toBe(false);
  expect(more[0]).toBe(true);
  expect(new Set(w.files()).size).toBe(260);
  expect(w.files()).toHaveLength(260);
});

it('pages on when a full page shares one updated_at, rather than looping', async () => {
  const w = world();
  for (let i = 0; i < 60; i++) w.q.tx({ updated_at: '2026-11-03T10:00:00.000Z' });
  for (let i = 0; i < 4 && (await w.sweep())?.more; i++);
  expect(new Set(w.files()).size).toBe(60);
});

it('stops quietly at a rate limit and keeps what landed', async () => {
  const w = world();
  w.q.tx();
  w.q.status['/v2/supplier_invoices'] = 429;
  await expect(w.sweep()).resolves.toMatchObject({ more: true });
  expect(w.files()).toHaveLength(1);
  delete w.q.status['/v2/supplier_invoices'];
  await expect(w.sweep()).resolves.toMatchObject({ more: false });
  expect(w.files()).toHaveLength(1);
});

it('fails a sweep the key is refused on, so the space can say so', async () => {
  const w = world();
  w.q.status['/v2/organization'] = 401;
  await expect(w.sweep()).rejects.toThrow(/401/);
});

it('lands a file over the size cap without its bytes', async () => {
  const w = world();
  const a = { ...w.q.file(), file_size: String(60 * 1024 * 1024) };
  w.q.tx({ attachments: [a], attachment_ids: [a.id] });
  await w.sweep();
  expect(w.changes.find((c) => c.change === 'upsert' && c.itemId === `att:${a.id}`)).toMatchObject({ content: 'too-large' });
  expect(w.q.calls.some((c) => c.url.startsWith(FILES))).toBe(false);
});
