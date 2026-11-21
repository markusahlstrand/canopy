/**
 * A folder of an a3doc space checked when someone opens it, end to end on a real scope: the drive
 * records the request, the platform's poll runs the connector's sweep, the sweep takes the request
 * (`withFolderChecks`), the a3doc connector reads that one folder, and its changes land through
 * `drive/land-source-change` like any sync's. Only a3doc is fake: a small stand-in for its WebAPI.
 */
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { connectionId, instant, platformActorId, principalId, scopeId, tenantId, type AttachmentRecord } from '@substrat-run/contracts';
import { Hono } from 'hono';
import { ulid, type ScopedConnectionContext } from '@substrat-run/kernel';
import { a3docConnectorDefinition, a3docFolderChecks, A3DOC_VERTICAL_PROVIDER } from '@canopy/connector-a3docs';
import { DRIVE_PERM, driveManifest, driveModule } from '@canopy/scope-drive';
import { ROLES } from '@canopy/scope-drive/provision';
import { hasFolderChecks, withFolderChecks } from '../src/folder-checks';
import { mountSource, type FolderRefreshAnswer } from '../src/source-routes';

const ADDRESS = 'https://addr.a3.test', API = 'https://a3.test/WebAPI/v1';
const LOGIN = { companyCode: 'C1', user: 'cliente', password: 'pw' };

/** Just enough of a3doc's WebAPI: one login, a tree, documents newest first, downloads. */
class TinyA3doc {
  mfa = 0;
  token: string | null = null;
  calls: string[] = [];
  private minute = 0;
  docs: { Id: string; Code: number; Title: string; Type: string; body: string; DateModified: string; ContainersId: number[] }[] = [];
  /** Facturas holds four folders, so more are asked about than one sweep takes. */
  static readonly FOLDERS = { Recibidas: 21, Emitidas: 22, Bancos: 23, Nominas: 24 } as const;
  tree = [{ id: 1, name: 'Todos', children: [{ id: 20, name: 'Facturas', children: Object.entries(TinyA3doc.FOLDERS).map(([name, id]) => ({ id, name, children: null })) }] }];
  add(container: number, title: string, body: string) {
    const doc = { Id: `doc-${ulid()}`, Code: this.docs.length + 100, Title: title, Type: '.PDF', body, DateModified: this.stamp(), ContainersId: [container] };
    this.docs.push(doc);
    return doc;
  }
  stamp() { this.minute++; return `01/11/2026 10:${String(this.minute).padStart(2, '0')}:00`; }
  readonly fetch = (async (url: string, init?: { body?: string }) => {
    if (url.startsWith(`${ADDRESS}/v1/Address/`)) return Response.json({ URL: API.replace(/\/v1$/, '') });
    const method = url.slice(API.length + 1), body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
    this.calls.push(method);
    if (method === 'LoginMfaBegin') return Response.json({ errorCode: 0, mfaStatus: this.mfa });
    if (method === 'LoginMfaComplete') return Response.json(this.mfa === 2 ? { errorCode: 3 } : { errorCode: 0, token: (this.token = `t${this.calls.length}`) });
    if (body.token !== this.token) return Response.json({ errorCode: 6 });
    if (method === 'UserInfo') return Response.json({ errorCode: 0, userRol: '1' });
    if (method === 'ContainersTree') return Response.json({ errorCode: 0, tree: this.tree });
    if (method === 'Download') {
      const doc = this.docs.find(d => d.Id === body.documentId);
      return Response.json(doc ? { errorCode: 0, content: btoa(doc.body) } : { errorCode: 2 });
    }
    if (method === 'GetDocumentsExtended') {
      const cid = (body.containersIdsToSearch as number[])[0]!;
      const within = (d: { ContainersId: number[] }) => cid === 1 || d.ContainersId.includes(cid) || (body.searchChildContainers === true && cid === 20 && d.ContainersId.some(c => c > 20 && c < 25));
      const title = (body.filter as { FilterValue: string }[])[0]?.FilterValue;
      const hits = this.docs.filter(within).filter(d => title === undefined || d.Title === title).sort((a, b) => b.DateModified.localeCompare(a.DateModified));
      const size = body.pageSize as number, start = (body.pageIndex as number) * size;
      return Response.json({ errorCode: 0, countAllDocuments: hits.length, documents: hits.slice(start, start + size).map(({ body: b, ...d }) => ({ ...d, Size: Math.ceil(b.length / 1024) })) });
    }
    return Response.json({ errorCode: 3 });
  }) as unknown as ScopedConnectionContext['fetch'];
}

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'folder-refresh-')); dirs.push(dir);
  let now = Date.parse('2026-11-21T10:00:00.000Z');
  const host = new SqliteScopeHost({ dir, clock: () => instant.parse(new Date(now).toISOString()) }); host.registerModule(driveModule);
  const staff = platformActorId.parse(ulid()), t = tenantId.parse(ulid()), s = scopeId.parse(ulid());
  const owner = principalId.parse(ulid()), connection = principalId.parse(ulid()), member = principalId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: 'a3docs', name: 'a3docs' });
  await host.admin.grantEntitlement(staff, t, driveManifest.entitlementKey as string);
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'drive' });
  await host.admin.activateScope(staff, t, s);
  await host.provisionBlobStore(staff, { tenantId: t, vertical: 'drive', binding: 'BLOBS' });
  for (const role of ROLES) await host.admin.defineRole(staff, t, role);
  // The connection holds what a binding grants it: landing, and the drive's write for attachments.
  for (const p of [owner, connection]) await host.admin.assignRole(staff, { principalId: p, roleKey: 'owner', node: { tenantId: t, scopeId: s } });
  await host.admin.assignRole(staff, { principalId: member, roleKey: 'member', node: { tenantId: t, scopeId: s } });
  await host.admin.grant(staff, { principalId: connection, permission: DRIVE_PERM.landSource, node: { tenantId: t, scopeId: s }, grantedBy: connection });
  const asConnection = await host.getScope(connection, t, s), asOwner = await host.getScope(owner, t, s), asMember = await host.getScope(member, t, s);
  const bytes = await host.attachments(connection, t, s);
  const conn = connectionId.parse(ulid());
  await asOwner.invoke('drive/record-source', { provider: A3DOC_VERTICAL_PROVIDER, connectionId: conn, account: LOGIN.companyCode, folder: 'Facturas', canUpload: false });

  const a3 = new TinyA3doc();
  const state = new Map<string, unknown>();
  const ctx: ScopedConnectionContext = {
    connection: { id: conn, tenantId: t, provider: A3DOC_VERTICAL_PROVIDER, vertical: 'drive', externalAccountRef: LOGIN.companyCode, expiresAt: null },
    secret: LOGIN, fetch: a3.fetch,
    state: {
      get: async key => structuredClone(state.get(key)),
      put: async (key, value) => { if (value === null) state.delete(key); else state.set(key, structuredClone(value)); },
      list: async (prefix = '') => [...state].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })),
    },
    scope: { tenantId: t, scopeId: s, operation: 'drive/land-source-change', options: {} },
    land: async <O>(input: unknown) => asConnection.invoke<O>('drive/land-source-change', input),
    invoke: async <O>(operation: string, input?: unknown) => asConnection.invoke<O>(operation, input),
    attachments: {
      upload: async (input) => bytes.upload({ ...input, body: input.body instanceof Uint8Array ? input.body : new Uint8Array(await new Response(input.body.stream as ReadableStream).arrayBuffer()) }) as Promise<AttachmentRecord>,
      open: async () => null,
    },
  };
  const def = withFolderChecks(a3docConnectorDefinition({ addressProvider: ADDRESS, journalOperation: 'drive/source-write-journal' }), a3docFolderChecks({ addressProvider: ADDRESS }));
  ctx.scope.options = await def.bind!(ctx, { folder: 'Facturas' });
  /** One platform poll: a call whose state writes stay only if it succeeds. */
  const poll = async () => {
    const before = structuredClone(state);
    try { return await def.sweep!(ctx); } catch (e) { state.clear(); for (const [k, v] of before) state.set(k, v); throw e; }
  };
  const folderAt = async (path: string) => (await asMember.invoke<{ id: string } | null>('drive/folder-by-path', { path }))!.id;
  const names = async (folderId: string) =>
    (await asMember.invoke<{ entries: { name: string }[] }>('drive/list-folder', { folderId })).entries.map(f => f.name).sort();
  const open = (folderId: string, force = false) => asMember.invoke<{ decision: string; refresh: { state: string; changes: number; error: string | null } | null }>('drive/request-folder-refresh', { folderId, force });
  /**
   * The worker's route, on this scope, with the platform's poll: it runs the sweep above, or answers
   * 429 while `throttled` (the platform polled this binding within the last minute).
   */
  const platform = { throttled: false, polls: 0 };
  const fetchImpl = (async (url: string | URL | Request) => {
    if (!String(url).endsWith('/internal/connections/sync')) return new Response(null, { status: 404 });
    if (platform.throttled) return Response.json({ error: 'polled within the last minute' }, { status: 429 });
    platform.polls++;
    const result = await poll();
    return Response.json({ bindings: [{ connectionId: conn, outcome: result?.landed ? 'landed' : 'unchanged', at: new Date(now).toISOString(), pending: !!result?.more }] });
  }) as typeof fetch;
  const app = new Hono();
  mountSource(app, async () => ({
    scope: asMember,
    relay: () => ({ controlPlaneUrl: 'https://cp.test', platformSecret: 'secret', tenantId: t, scopeId: s, fetchImpl }),
  }), { checksFolders: () => hasFolderChecks(def) });
  const openRoute = async (folderId: string) =>
    (await (await app.request(`/api/source/folders/${folderId}/refresh`, { method: 'POST', body: '{}' })).json()) as FolderRefreshAnswer;
  const advance = (ms: number) => { now += ms; };
  return { a3, state, poll, folderAt, names, open, openRoute, platform, advance };
}

it('checks the folder a member opened, landing what a3doc added, changed and removed there', async () => {
  const w = await world();
  const a = w.a3.add(21, 'Invoice A', 'first');
  const b = w.a3.add(21, 'Invoice B', 'second');
  await w.poll(); // the first sync, before anyone opened anything
  const recibidas = await w.folderAt('Recibidas');
  expect(await w.names(recibidas)).toEqual(['Invoice A.pdf', 'Invoice B.pdf']);

  w.a3.add(21, 'Invoice C', 'third');
  Object.assign(a, { body: 'first, corrected', DateModified: w.a3.stamp() });
  w.a3.docs.splice(w.a3.docs.indexOf(b), 1);

  expect(await w.open(recibidas)).toMatchObject({ decision: 'start', refresh: { state: 'checking' } });
  const logins = w.a3.calls.filter(m => m === 'LoginMfaBegin').length;
  expect(await w.poll()).toEqual({ landed: 3, more: true });
  // The session the first sync signed in with served the check: no second login.
  expect(w.a3.calls.filter(m => m === 'LoginMfaBegin').length).toBe(logins);
  expect(await w.names(recibidas)).toEqual(['Invoice A.pdf', 'Invoice C.pdf']);
  expect(await w.open(recibidas)).toMatchObject({ decision: 'fresh', refresh: { state: 'checked', changes: 3, error: null } });
  // With nothing asked, the next poll is the ordinary pass again.
  expect(await w.poll()).toMatchObject({ more: false });
});

it('shows a failed check on the folder, leaves its listing alone, and fails the poll', async () => {
  const w = await world();
  w.a3.add(21, 'Invoice A', 'first');
  await w.poll();
  const recibidas = await w.folderAt('Recibidas');
  w.state.clear(); // no kept session: the check has to sign in, and a3doc now wants MFA
  w.a3.token = null;
  w.a3.mfa = 2;
  expect((await w.open(recibidas, true)).decision).toBe('start');
  await expect(w.poll()).rejects.toThrow('MFA');
  expect(await w.open(recibidas)).toMatchObject({ decision: 'fresh', refresh: { state: 'failed', error: expect.stringContaining('MFA') } });
  expect(await w.names(recibidas)).toEqual(['Invoice A.pdf']);
});

it('leaves folders a sweep did not take waiting, never "checked", when more are asked about than it takes', async () => {
  const w = await world();
  const F = TinyA3doc.FOLDERS;
  for (const [name, id] of Object.entries(F)) w.a3.add(id, `${name} old`, 'old');
  await w.poll();
  const ids = Object.fromEntries(await Promise.all(Object.keys(F).map(async name => [name, await w.folderAt(name)] as const))) as Record<keyof typeof F, string>;
  for (const [name, id] of Object.entries(F)) w.a3.add(id, `${name} new`, 'new');

  // Four folders opened while the platform will not poll again yet: each request waits.
  w.platform.throttled = true;
  for (const name of Object.keys(F) as (keyof typeof F)[]) {
    expect(await w.openRoute(ids[name])).toMatchObject({ refresh: { state: 'checking' }, retryAfterMs: 5_000 });
    w.advance(1_000);
  }
  // A minute on, the page asks again for the first, and this time the poll runs.
  w.platform.throttled = false;
  w.advance(60_000);
  // Recibidas's request starts again, so it is now the newest; the sweep takes the three oldest.
  expect(await w.openRoute(ids.Recibidas)).toMatchObject({ refresh: { state: 'checking' }, retryAfterMs: 5_000 });
  expect(w.platform.polls).toBe(1);
  expect(await w.names(ids.Recibidas)).toEqual(['Recibidas old.pdf']);
  for (const name of ['Emitidas', 'Bancos', 'Nominas'] as const) {
    expect(await w.openRoute(ids[name])).toEqual({ refresh: expect.objectContaining({ state: 'checked', changes: 1 }) });
    expect(await w.names(ids[name])).toEqual([`${name} new.pdf`, `${name} old.pdf`]);
  }
  // Its own check comes with the next poll the page's re-asking starts.
  w.advance(61_000);
  expect(await w.openRoute(ids.Recibidas)).toEqual({ refresh: expect.objectContaining({ state: 'checked', changes: 1 }) });
  expect(await w.names(ids.Recibidas)).toEqual(['Recibidas new.pdf', 'Recibidas old.pdf']);
});
