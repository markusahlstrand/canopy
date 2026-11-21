import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { instant, platformActorId, principalId, scopeId, tenantId, type FileSourceChange } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { driveManifest, driveModule, DRIVE_PERM, ROOT_FOLDER_ID } from '../src/index.js';
import { ROLES } from '../src/provision.js';
import type { FolderRefresh } from '../spec/model.js';

type Ask = { decision: 'start' | 'joined' | 'fresh' | 'unsupported'; provider: string | null; refresh: FolderRefresh | null };

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'folder-refresh-')); dirs.push(dir);
  let now = Date.parse('2026-11-21T10:00:00.000Z');
  const host = new SqliteScopeHost({ dir, clock: () => instant.parse(new Date(now).toISOString()) }); host.registerModule(driveModule);
  const staff = platformActorId.parse(ulid()), t = tenantId.parse(ulid()), s = scopeId.parse(ulid());
  const owner = principalId.parse(ulid()), source = principalId.parse(ulid()), viewer = principalId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: 'refresh', name: 'Refresh' });
  await host.admin.grantEntitlement(staff, t, driveManifest.entitlementKey as string);
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'drive' });
  await host.admin.activateScope(staff, t, s);
  for (const role of ROLES) await host.admin.defineRole(staff, t, role);
  await host.admin.assignRole(staff, { principalId: owner, roleKey: 'owner', node: { tenantId: t, scopeId: s } });
  await host.admin.assignRole(staff, { principalId: source, roleKey: 'owner', node: { tenantId: t, scopeId: s } });
  await host.admin.assignRole(staff, { principalId: viewer, roleKey: 'viewer', node: { tenantId: t, scopeId: s } });
  await host.admin.grant(staff, { principalId: source, permission: DRIVE_PERM.landSource, node: { tenantId: t, scopeId: s }, grantedBy: source });
  const connector = await host.getScope(source, t, s), human = await host.getScope(owner, t, s), member = await host.getScope(viewer, t, s);
  const connect = () => human.invoke('drive/record-source', { provider: 'canopy.a3doc', connectionId: 'connection', account: 'ACME', folder: '', canUpload: false });
  const folder = async (path: string) => {
    const change: FileSourceChange = { change: 'upsert', connectionId: 'connection', itemId: `c-${path}`, kind: 'folder', path, name: path.split('/').at(-1)!, previousPath: null, size: null, contentType: null, lastModifiedAt: null, webUrl: null, content: null };
    return (await connector.invoke<{ entity: { entityId: string } }>('drive/land-source-change', change)).entity.entityId;
  };
  const ask = (folderId: string, extra: { force?: boolean; throttleMs?: number } = {}, as = member) => as.invoke<Ask>('drive/request-folder-refresh', { folderId, ...extra });
  const take = (limit = 3) => connector.invoke<{ folders: { folderId: string; path: string }[] }>('drive/source-folder-requests', { limit });
  const checked = (folderId: string, changes: number, error?: string, requeue?: boolean) => connector.invoke<{ refresh: FolderRefresh | null }>('drive/source-folder-checked', { folderId, changes, ...(error ? { error } : {}), ...(requeue ? { requeue } : {}) });
  const settle = (folderId: string, outcome: 'checked' | 'failed', error?: string) =>
    member.invoke<{ refresh: FolderRefresh }>('drive/settle-folder-refresh', { folderId, outcome, ...(error ? { error } : {}) });
  const emitted = async () => Number((await host.admin.queryScope(staff, t, s, { sql: `SELECT COUNT(*) FROM _substrat_outbox WHERE type = 'drive.folder-checked'` })).rows[0]![0]);
  const advance = (byMs: number) => { now += byMs; };
  return { connect, folder, ask, take, checked, settle, emitted, advance, member, human };
}

it('asks nothing of a space with no source', async () => {
  const w = await world();
  expect(await w.ask(ROOT_FOLDER_ID)).toEqual({ decision: 'unsupported', provider: null, refresh: null });
});

it('starts one check, joins a second open of the same folder, and stays fresh for the throttle', async () => {
  const w = await world();
  await w.connect();
  const facturas = await w.folder('Facturas');
  const first = await w.ask(facturas);
  expect(first).toMatchObject({ decision: 'start', provider: 'canopy.a3doc', refresh: { state: 'checking', path: 'Facturas', checkedAt: null } });
  // Another tab, or another member, opening it while the check runs waits for that one.
  expect((await w.ask(facturas, {}, w.human)).decision).toBe('joined');
  expect(await w.take()).toEqual({ folders: [{ folderId: facturas, path: 'Facturas' }] });
  // Taken: a second sweep does not take it again while the first is on it.
  expect(await w.take()).toEqual({ folders: [] });
  w.advance(5_000);
  expect((await w.checked(facturas, 2)).refresh).toMatchObject({ state: 'checked', changes: 2, error: null, checkedAt: '2026-11-21T10:00:05.000Z' });
  expect(await w.emitted()).toBe(1);
  w.advance(30_000);
  expect(await w.ask(facturas)).toMatchObject({ decision: 'fresh', refresh: { state: 'checked' } });
  // The person pressing refresh is never throttled by the freshness window.
  expect((await w.ask(facturas, { force: true })).decision).toBe('start');
});

it('starts again once the throttle has passed, and honours a configured throttle with a floor', async () => {
  const w = await world();
  await w.connect();
  const id = await w.folder('Bancos');
  await w.ask(id); await w.take(); await w.checked(id, 0);
  w.advance(61_000);
  expect((await w.ask(id)).decision).toBe('start');
  await w.take(); await w.checked(id, 0);
  w.advance(61_000);
  expect((await w.ask(id, { throttleMs: 5 * 60_000 })).decision).toBe('fresh');
  // A throttle under the floor is raised to it: ten seconds, not one.
  w.advance(5 * 60_000);
  await w.ask(id); await w.take(); await w.checked(id, 0);
  w.advance(1_000);
  expect((await w.ask(id, { throttleMs: 1 })).decision).toBe('fresh');
  w.advance(10_000);
  expect((await w.ask(id, { throttleMs: 1 })).decision).toBe('start');
});

it('restarts a request no connector took after a minute, and one a connector dropped after three', async () => {
  const w = await world();
  await w.connect();
  const id = await w.folder('Nominas');
  await w.ask(id);
  w.advance(30_000);
  expect((await w.ask(id)).decision).toBe('joined');
  w.advance(31_000);
  expect((await w.ask(id)).decision).toBe('start');
  await w.take();
  w.advance(2 * 60_000);
  expect((await w.ask(id)).decision).toBe('joined');
  w.advance(61_000);
  // The connector's call died without answering: the folder is no longer shown as checking.
  expect(await w.ask(id)).toMatchObject({ decision: 'start' });
});

it('hands a connector the oldest requests first, a few at a time, and forgets ones nobody waits for', async () => {
  const w = await world();
  await w.connect();
  const ids = [];
  for (const name of ['A', 'B', 'C', 'D']) { ids.push(await w.folder(name)); }
  for (const id of ids) { await w.ask(id); w.advance(1_000); }
  expect((await w.take(2)).folders.map(f => f.path)).toEqual(['A', 'B']);
  w.advance(11 * 60_000);
  expect((await w.take()).folders).toEqual([]);
});

it('records a failed check quietly and does not ask a failing source again on every open', async () => {
  const w = await world();
  await w.connect();
  const id = await w.folder('Facturas');
  await w.ask(id); await w.take();
  expect((await w.checked(id, 0, 'a3doc wants its MFA challenge passed')).refresh).toMatchObject({ state: 'failed', error: 'a3doc wants its MFA challenge passed' });
  w.advance(20_000);
  expect(await w.ask(id)).toMatchObject({ decision: 'fresh', refresh: { state: 'failed' } });
  // A later success clears the error.
  expect((await w.ask(id, { force: true })).decision).toBe('start');
  await w.take();
  expect((await w.checked(id, 1)).refresh).toMatchObject({ state: 'checked', error: null });
});

it('settles a poll for a source that reads no single folder, but never over a connector that took it', async () => {
  const w = await world();
  await w.connect();
  const untaken = await w.folder('Transactions'), taken = await w.folder('Facturas');
  await w.ask(taken); w.advance(1_000); await w.ask(untaken);
  await w.take(1); // the connector took only the first asked
  expect((await w.settle(taken, 'checked')).refresh.state).toBe('checking');
  expect((await w.settle(untaken, 'checked')).refresh).toMatchObject({ state: 'checked', error: null });
  // A failed poll ends even a taken request, with the platform's reason.
  expect((await w.settle(taken, 'failed', 'source down')).refresh).toMatchObject({ state: 'failed', error: 'source down' });
  // Nothing open: a settle changes nothing and emits nothing.
  const before = await w.emitted();
  expect((await w.settle(untaken, 'failed', 'late')).refresh.state).toBe('checked');
  expect(await w.emitted()).toBe(before);
});

it('refuses the connector operations to a member, and asking about a folder that does not exist', async () => {
  const w = await world();
  await w.connect();
  await expect(w.member.invoke('drive/source-folder-requests', { limit: 3 })).rejects.toThrow();
  await expect(w.member.invoke('drive/source-folder-checked', { folderId: ROOT_FOLDER_ID, changes: 0 })).rejects.toThrow();
  await expect(w.ask('missing')).rejects.toThrow();
});

it('puts a check a budget stopped back in the queue, still checking, for the next call to take', async () => {
  const w = await world();
  await w.connect();
  const id = await w.folder('Facturas');
  await w.ask(id); await w.take();
  expect((await w.checked(id, 4, undefined, true)).refresh).toMatchObject({ state: 'checking', checkedAt: null });
  expect(await w.emitted()).toBe(0);
  // Not taken any more: the follow-up call takes it at once, without the three-minute wait.
  expect(await w.take()).toEqual({ folders: [{ folderId: id, path: 'Facturas' }] });
  expect((await w.ask(id)).decision).toBe('joined');
  expect((await w.checked(id, 2)).refresh).toMatchObject({ state: 'checked', changes: 2 });
  // A requeue that carries an error is a failure, not more to read.
  await w.ask(id, { force: true }); await w.take();
  expect((await w.checked(id, 0, 'a3doc went away', true)).refresh).toMatchObject({ state: 'failed', error: 'a3doc went away' });
});

it('queues a request made in the same instant a check finished', async () => {
  const w = await world();
  await w.connect();
  const id = await w.folder('Facturas');
  await w.ask(id); await w.take(); await w.checked(id, 0);
  // Same clock reading: the new request must not read as answered by the check just recorded.
  expect((await w.ask(id, { force: true })).decision).toBe('start');
  expect(await w.take()).toEqual({ folders: [{ folderId: id, path: 'Facturas' }] });
  expect((await w.ask(id)).decision).toBe('joined');
});
