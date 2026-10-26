import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectionId,
  moduleManifest,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type ConnectionId,
  type FileSourceChange,
  type FileSourceWriteRequest,
} from '@substrat-run/contracts';
import { assertAllowed, ulid, webCryptoSecretBox, type OperationHandler } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { testOperations } from '@substrat-run/contract-tests';
import { fileSourceChange } from '@substrat-run/contracts';
import {
  A3DOC_FILES_EVENT,
  a3docCredentialSummary,
  bindA3docScope,
  listA3docBindings,
  probeA3docConnection,
  probeA3docSecret,
  registerA3docFilesConnector,
  syncA3docScope,
  sweepA3docFiles,
  unbindA3docScope,
} from '../src/index.js';
import { ADDRESS, API, COMPANY, CUSTOMER, FakeA3doc, PASSWORD, USER } from './fake-a3doc.js';

/**
 * An a3doc folder end to end on the pure adapter: a real scope with a vertical module, a real
 * connection and its grants, the write dispatch run by the host, and the sync landing through the
 * vertical's own operation, against `FakeA3doc`. No network: the fake is the only fetch.
 */

const LAND = permissionKey.parse('docs:land');
const ATTACH = permissionKey.parse('docs:attach');
const READ = permissionKey.parse('docs:read');
const SEND = permissionKey.parse('docs:send');

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function world(opts: { grantLand?: boolean; customerId?: string } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'canopy-a3docs-'));
  const a3 = new FakeA3doc();
  const landed: FileSourceChange[] = [];
  const docsMod = {
    manifest: moduleManifest.parse({
      id: '@test/docs',
      version: '1.0.0',
      kernelContract: '^0.0.1',
      permissions: [
        { key: 'docs:land', description: 'land a source change' },
        { key: 'docs:attach', description: 'attach bytes to a doc' },
        { key: 'docs:read', description: 'read a doc and its attachments' },
        { key: 'docs:send', description: 'put a doc in a3doc' },
      ],
      events: {
        emits: [
          { type: 'attachment.added', schemaVersion: 1 },
          { type: 'attachment.removed', schemaVersion: 1 },
          { type: A3DOC_FILES_EVENT, schemaVersion: 1 },
        ],
        consumes: [],
      },
      migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
      attachmentTargets: [{ entityType: 'doc', readPermission: 'docs:read', writePermission: 'docs:attach' }],
      entitlementKey: 'docs',
    }),
    ...testOperations({
      'docs/land': (async (ctx, input: unknown) => {
        assertAllowed(await ctx.check(LAND));
        const change = fileSourceChange.parse(input);
        landed.push(change);
        if (change.change === 'upsert' && change.content === 'follows') return { entity: { entityType: 'doc', entityId: `d-${change.itemId}` } };
        return { ok: true };
      }) as OperationHandler<never, unknown>,
      'docs/send': (async (ctx, input: FileSourceWriteRequest) => {
        assertAllowed(await ctx.check(SEND));
        ctx.emit({ type: A3DOC_FILES_EVENT, schemaVersion: 1, entity: { entityType: 'doc', entityId: 'd1' }, piiClass: 'none', payload: input });
        return { ok: true };
      }) as OperationHandler<never, unknown>,
    }),
  };

  const options = { fetch: a3.fetch, addressProvider: ADDRESS };
  const host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(5)), fetch: a3.fetch });
  host.registerModule(docsMod);
  registerA3docFilesConnector(host, { ...options, retry: { maxAttempts: 5, baseDelayMs: 0 } });

  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const author = principalId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
  await host.admin.grantEntitlement(staff, t, 'docs');
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
  await host.admin.activateScope(staff, t, s);
  await host.admin.defineRole(staff, t, { key: 'author', permissions: [READ, ATTACH, SEND], source: 'vertical' });
  await host.admin.assignRole(staff, { principalId: author, roleKey: 'author', node: { tenantId: t, scopeId: s } });
  await host.provisionBlobStore(staff, { tenantId: t, vertical: 'docs', binding: 'ATTACHMENTS' });

  const conn: ConnectionId = connectionId.parse(ulid());
  await host.admin.createConnection(staff, {
    id: conn,
    tenantId: t,
    vertical: 'docs',
    provider: 'a3doc',
    label: 'Gestoría a3doc',
    secret: { companyCode: COMPANY, user: USER, password: PASSWORD, ...(opts.customerId ? { customerId: opts.customerId } : {}) },
  });
  if (opts.grantLand !== false) {
    for (const permission of [LAND, ATTACH]) {
      await host.admin.grantToConnection(staff, { connectionId: conn, permission, node: { tenantId: t, scopeId: s }, grantedBy: staff });
    }
  }

  const stub = await host.getScope(author, t, s);
  const attachments = await host.attachments(author, t, s);
  const attach = (filename: string, body: string) =>
    attachments.upload({ entity: { entityType: 'doc', entityId: 'd1' }, filename, contentType: 'application/pdf', visibility: 'internal', body: new TextEncoder().encode(body) });
  const bind = (folder = '') =>
    bindA3docScope(host, { connectionId: conn, tenantId: t, scopeId: s, vertical: 'docs', operation: 'docs/land', permission: 'docs:land', folder }, options);
  const sync = async ({ now, ...budget }: { maxPages?: number; maxVerify?: number; now?: Date } = {}) => {
    const [binding] = await listA3docBindings(host, conn);
    return syncA3docScope(host, conn, binding!, { ...options, ...budget, ...(now ? { now: () => now } : {}) });
  };
  const send = (payload: FileSourceWriteRequest) => stub.invoke('docs/send', payload);
  const ledgers = async () => (await host.admin.listConnectorState(conn, 'a3doc:write:')).map((r) => r.value as { status: string; files: { documentId?: string }[] });
  /** The paths the vertical holds after applying everything landed so far, by item id. */
  const mirror = () => {
    const held = new Map<string, string>();
    for (const c of landed) {
      if (c.change === 'upsert') held.set(c.itemId, c.path);
      if (c.change === 'delete') held.delete(c.itemId);
    }
    return held;
  };
  const tomorrow = () => new Date(Date.now() + 25 * 60 * 60 * 1000);
  return { host, a3, landed, staff, t, s, conn, stub, attach, bind, sync, send, ledgers, mirror, options, tomorrow };
}

const pathsOf = (m: Map<string, string>) => [...m.values()].sort();

describe('bind', () => {
  it('resolves a folder by its path, keeps its id, and records the upload role and customer', async () => {
    const w = await world();
    const b = await w.bind('Facturas/Recibidas');
    expect(b).toMatchObject({ folder: 'Facturas/Recibidas', containerId: 21, canUpload: true });
    expect(b.customerId).toBeUndefined(); // an empty folder carries no customer
    w.a3.add([1], 'Escritura', 'deed');
    expect((await w.bind('')).customerId).toBe(CUSTOMER);
  });

  it('refuses a missing grant, and a path that is no folder', async () => {
    await expect((await world({ grantLand: false })).bind()).rejects.toThrow(/does not hold 'docs:land'/);
    await expect((await world()).bind('Fiscal/Nope')).rejects.toThrow(/no a3doc folder/);
  });

  it('records a read-only a3doc role as unable to upload', async () => {
    const w = await world();
    w.a3.role = 6;
    expect((await w.bind()).canUpload).toBe(false);
  });
});

describe('sync', () => {
  it('lands the folder tree and every document with its bytes, under stable item ids', async () => {
    const w = await world();
    w.a3.add([11], '303 3T', '%PDF 303');
    w.a3.add([1], 'Escritura', '%PDF deed');
    await w.bind();
    const r = await w.sync();
    expect(r).toMatchObject({ complete: true, full: true });
    expect(pathsOf(w.mirror())).toEqual(['Escritura.pdf', 'Facturas', 'Facturas/Recibidas', 'Fiscal', 'Fiscal/Modelo 303', 'Fiscal/Modelo 303/303 3T.pdf']);
    const content = w.landed.filter((c) => c.change === 'content');
    expect(content).toHaveLength(2);
    expect(content.every((c) => c.change === 'content' && c.replaces === null)).toBe(true);
    // A second sync with nothing changed lands nothing.
    const before = w.landed.length;
    await w.sync();
    expect(w.landed.length).toBe(before);
  });

  it('keeps names stable: a clash suffixes the later arrival, and removing a sibling renames nothing', async () => {
    const w = await world();
    const first = w.a3.add([21], 'Factura', 'one');
    await w.bind();
    await w.sync();
    const second = w.a3.add([21], 'Factura', 'two');
    await w.sync();
    expect(pathsOf(w.mirror()).filter((p) => p.startsWith('Facturas/Recibidas/'))).toEqual([
      'Facturas/Recibidas/Factura.pdf',
      `Facturas/Recibidas/Factura (${second.Code}).pdf`,
    ].sort());
    w.a3.remove(first);
    await w.sync({ now: w.tomorrow() }); // a full pass checks the unseen item on its own
    expect(w.mirror().get(`${second.Id}@21`)).toBe(`Facturas/Recibidas/Factura (${second.Code}).pdf`);
    expect(w.landed.at(-1)).toMatchObject({ change: 'delete', itemId: `${first.Id}@21`, reason: 'deleted' });
  });

  it('lands an edit as new content that names the content it replaces, and a retitle as a move of the same item', async () => {
    const w = await world();
    const doc = w.a3.add([21], 'Factura', 'v1');
    await w.bind();
    await w.sync();
    const firstAttachment = (w.landed.find((c) => c.change === 'content') as Extract<FileSourceChange, { change: 'content' }>).attachment.id;
    w.a3.edit(doc, { bytes: new TextEncoder().encode('v2 is longer than one kilobyte?'.repeat(40)) });
    await w.sync();
    const second = w.landed.filter((c) => c.change === 'content').at(-1) as Extract<FileSourceChange, { change: 'content' }>;
    expect(second.replaces).toBe(firstAttachment);

    const mark = w.landed.length;
    w.a3.edit(doc, { Title: 'Factura Acme' });
    await w.sync();
    // A retitle bumps DateModified in a3doc, so the bytes are landed again after the move.
    expect(w.landed.slice(mark).find((c) => c.change === 'upsert')).toMatchObject({
      itemId: `${doc.Id}@21`,
      path: 'Facturas/Recibidas/Factura Acme.pdf',
      previousPath: 'Facturas/Recibidas/Factura.pdf',
    });
  });

  it('a document filed in two folders is two items, and leaving one is a moved-out of that one only', async () => {
    const w = await world();
    const doc = w.a3.add([11, 21], 'Modelo', 'both');
    await w.bind();
    await w.sync();
    expect(w.mirror().get(`${doc.Id}@11`)).toBe('Fiscal/Modelo 303/Modelo.pdf');
    expect(w.mirror().get(`${doc.Id}@21`)).toBe('Facturas/Recibidas/Modelo.pdf');
    w.a3.edit(doc, { ContainersId: [11] });
    await w.sync();
    expect(w.landed.at(-1)).toMatchObject({ change: 'delete', itemId: `${doc.Id}@21`, reason: 'moved-out' });
    expect(w.mirror().has(`${doc.Id}@11`)).toBe(true);
  });

  it('an incremental pass reads only down to the high-water mark minus the overlap', async () => {
    const w = await world();
    for (let i = 0; i < 5; i++) w.a3.add([21], `F${i}`, `doc ${i}`);
    await w.bind();
    await w.sync();
    const listCalls = () => w.a3.calls.filter((c) => c.method === 'GetDocumentsExtended').length;
    const before = listCalls();
    w.a3.add([21], 'New', 'new');
    const r = await w.sync();
    expect(r.full).toBe(false);
    expect(listCalls() - before).toBe(1);
    expect(w.mirror().size).toBe(4 /* folders */ + 6);
  });

  it('a file over the cap lands without bytes, and nothing is downloaded for it', async () => {
    const w = await world();
    const big = w.a3.add([21], 'Escaneo', 'tiny', { sizeKb: 60 * 1024 });
    await w.bind();
    await w.sync();
    expect(w.landed.find((c) => c.change === 'upsert' && c.itemId === `${big.Id}@21`)).toMatchObject({ content: 'too-large' });
    expect(w.a3.calls.some((c) => c.method === 'Download' && c.body.documentId === big.Id)).toBe(false);
  });

  it('a document last modified in the repeated October hour has its bytes compared on the next full pass', async () => {
    const w = await world();
    // 25/10/2026 02:30 happened twice in Madrid.
    const doc = w.a3.add([21], 'Nómina', 'v1 bytes', { modified: '25/10/2026 02:30:00' });
    await w.bind();
    await w.sync();
    const contents = () => w.landed.filter((c) => c.change === 'content').length;
    expect(contents()).toBe(1);
    // The second edit in the repeated hour: same wall clock, same size, different bytes.
    w.a3.edit(doc, { bytes: new TextEncoder().encode('v2 bytes') }, { touch: false });
    await w.sync();
    expect(contents()).toBe(1); // an incremental pass cannot tell
    await w.sync({ now: w.tomorrow() });
    expect(contents()).toBe(2); // the full pass compares the bytes
  });

  it('a pass cut at its page budget resumes where it stopped', async () => {
    const w = await world();
    for (let i = 0; i < 150; i++) w.a3.add([21], `F${i}`, `doc ${i}`);
    await w.bind();
    expect(await w.sync({ maxPages: 1 })).toMatchObject({ complete: false, pages: 1 });
    expect(await w.sync({ maxPages: 1 })).toMatchObject({ complete: true });
    expect([...w.mirror().keys()].filter((k) => k.includes('@')).length).toBe(150);
  });

  it('stops for a scope unbound mid-pass, and sweeps every bound scope', async () => {
    const w = await world();
    w.a3.add([21], 'F', 'x');
    await w.bind();
    const swept = await sweepA3docFiles(w.host, w.conn, w.options);
    expect(swept).toMatchObject({ found: 1, failed: [] });
    await unbindA3docScope(w.host, w.conn, w.s);
    expect(await listA3docBindings(w.host, w.conn)).toEqual([]);
  });
});

describe('write dispatch', () => {
  it('uploads into the bound folder, and the sync lands it under the name the request asked for', async () => {
    const w = await world();
    w.a3.add([21], 'Old', 'old');
    await w.bind();
    await w.sync();
    const a = await w.attach('Invoice Qonto.pdf', '%PDF qonto');
    await w.send({ directory: 'Facturas/Recibidas', files: [{ attachmentId: a.id, size: a.size }], conflict: 'rename' });
    expect(w.a3.titlesIn(21)).toEqual(['Invoice Qonto.pdf', 'Old.pdf']);
    const upload = w.a3.calls.find((c) => c.method === 'Upload')!.body;
    expect(upload).toMatchObject({ containersIds: [21], customerId: CUSTOMER, title: 'Invoice Qonto', extension: '.pdf', date: null });
    expect(await w.ledgers()).toEqual([expect.objectContaining({ status: 'done' })]);
    await w.sync();
    expect(pathsOf(w.mirror())).toContain('Facturas/Recibidas/Invoice Qonto.pdf');
  });

  it('files under the customer the connection names, over the one the folder carries', async () => {
    const w = await world({ customerId: 'X0000000T' });
    w.a3.add([21], 'Old', 'old');
    await w.bind();
    const a = await w.attach('a.pdf', 'a');
    await w.send({ directory: 'Facturas/Recibidas', files: [{ attachmentId: a.id, size: a.size }], conflict: 'rename' });
    expect(w.a3.calls.find((c) => c.method === 'Upload')!.body.customerId).toBe('X0000000T');
  });

  it("a lost upload answer is reconciled on retry: the attempt's own document is adopted, never uploaded twice", async () => {
    const w = await world();
    w.a3.add([21], 'Old', 'old');
    await w.bind();
    const a = await w.attach('Recibo.pdf', '%PDF recibo');
    w.a3.lostAnswers.push((m) => m === 'Upload');
    await w.send({ directory: 'Facturas/Recibidas', files: [{ attachmentId: a.id, size: a.size }], conflict: 'rename' });
    expect(await w.ledgers()).toEqual([expect.objectContaining({ status: 'pending' })]);
    await w.host.drainDue(w.t, w.s);
    expect(w.a3.titlesIn(21)).toEqual(['Old.pdf', 'Recibo.pdf']);
    expect(w.a3.calls.filter((c) => c.method === 'Upload')).toHaveLength(1);
    expect(await w.ledgers()).toEqual([expect.objectContaining({ status: 'done' })]);
  });

  it("does not adopt a same-titled document with other bytes: a person's file is left alone", async () => {
    const w = await world();
    w.a3.add([21], 'Recibo', "a person's recibo");
    await w.bind();
    const a = await w.attach('Recibo.pdf', 'ours');
    w.a3.lostAnswers.push((m) => m === 'Upload');
    await w.send({ directory: 'Facturas/Recibidas', files: [{ attachmentId: a.id, size: a.size }], conflict: 'rename' });
    // The lost answer's own document exists too; the person's has other bytes and is not it.
    await w.host.drainDue(w.t, w.s);
    expect(w.a3.calls.filter((c) => c.method === 'Upload')).toHaveLength(1);
    expect(w.a3.titlesIn(21)).toEqual(['Recibo.pdf', 'Recibo.pdf']);
  });

  it("refuses 'replace', a read-only role, a folder a3doc does not have, and (fail) a taken name", async () => {
    const w = await world();
    w.a3.add([21], 'Taken', 'x');
    await w.bind();
    await w.sync();
    const a = await w.attach('Taken.pdf', 'y');
    const file = [{ attachmentId: a.id, size: a.size }];
    const uploads = () => w.a3.calls.filter((c) => c.method === 'Upload').length;
    await w.send({ directory: 'Facturas/Recibidas', files: file, conflict: 'replace' });
    await w.send({ directory: 'Nueva carpeta', files: file, conflict: 'rename' });
    await w.send({ directory: 'Facturas/Recibidas', files: file, conflict: 'fail' });
    w.a3.role = 1;
    await w.bind();
    await w.send({ directory: 'Facturas/Recibidas', files: file, conflict: 'rename' });
    expect(uploads()).toBe(0);
    expect((await w.ledgers()).every((l) => l.status !== 'done')).toBe(true);
  });
});

describe('probes', () => {
  it('a wrong password is a refusal; the stored credential answers with who it is', async () => {
    const w = await world();
    const bad = await probeA3docSecret({ companyCode: COMPANY, user: USER, password: 'wrong' }, w.options);
    expect(bad).toMatchObject({ ok: false, refused: true });
    const unknown = await probeA3docSecret({ companyCode: 'NOPE', user: USER, password: PASSWORD }, w.options);
    expect(unknown).toMatchObject({ ok: false, refused: true });
    const incomplete = await probeA3docSecret({ companyCode: COMPANY }, w.options);
    expect(incomplete).toMatchObject({ ok: false, refused: true, error: expect.stringContaining('incomplete credential') });

    const live = await probeA3docConnection(w.host, { id: w.conn, tenantId: w.t, vertical: 'docs' }, w.options);
    expect(live).toMatchObject({ ok: true, accountRef: COMPANY, accountLabel: 'Cliente Prueba (cliente@example.com)' });
    expect(live.facts).toContainEqual({ label: 'Can upload', value: 'yes' });
  });

  it('the credential summary never shows the password', async () => {
    const w = await world();
    const summary = await a3docCredentialSummary(w.host, { id: w.conn, tenantId: w.t, vertical: 'docs' });
    expect(JSON.stringify(summary)).not.toContain(PASSWORD);
    expect(summary.fields.find((f) => f.key === 'password')).toMatchObject({ masked: true });
  });

  it('an unreachable a3doc is inconclusive, never a refusal', async () => {
    const down = { fetch: (async () => { throw new Error('ECONNREFUSED'); }) as never, addressProvider: ADDRESS, apiBase: API };
    expect(await probeA3docSecret({ companyCode: COMPANY, user: USER, password: PASSWORD }, down)).toMatchObject({ ok: false, refused: false });
  });
});
