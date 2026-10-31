import { expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ScopeId, TenantId } from '@substrat-run/contracts';
import type { ScopeStub } from '@substrat-run/kernel';
import { mountSource, type DriveSource } from './source-routes';

const tenantId = '01JZ00000000000000000TEN01' as TenantId, scopeId = '01JZ00000000000000000SC001' as ScopeId;
const CONNECTION = '01JZ00000000000000000C0N01', OTHER = '01JZ00000000000000000C0N02';

function world(options: { manager?: boolean; prior?: DriveSource | null; refuse?: { path: string; status: number; error: string } } = {}) {
  let source: DriveSource | null = options.prior ?? null;
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname, body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ path, body });
    if (options.refuse?.path === path) return Response.json({ error: options.refuse.error }, { status: options.refuse.status });
    const boundAt = '2026-10-31T10:00:00.000Z';
    switch (path) {
      case '/internal/connections/upsert': return Response.json({ connectionId: CONNECTION, created: true, granted: [] });
      case '/internal/connections/bind': return Response.json({ connectionId: body.connectionId, scopeId, options: { folder: 'Facturas/2026', containerId: 7, canUpload: true }, boundAt });
      case '/internal/connections/unbind': return Response.json({ connectionId: body.connectionId, scopeId, unbound: true });
      case '/internal/connections/bindings': return Response.json({ bindings: [{ connectionId: CONNECTION, provider: 'canopy.a3doc', status: 'active', options: {}, boundAt, lastSyncedAt: boundAt, lastError: null }] });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  const invoke = vi.fn(async (operation: string, input?: unknown) => {
    if (['drive/source-access', 'drive/record-source', 'drive/clear-source'].includes(operation) && !options.manager) throw new HTTPException(403);
    switch (operation) {
      case 'drive/get-source': return { source };
      case 'drive/source-access': return { principal: 'owner', source };
      case 'drive/record-source': return (source = { ...(input as DriveSource), boundAt: 'now' });
      case 'drive/clear-source': source = null; return { ok: true };
    }
    throw new Error(operation);
  });
  const app = new Hono();
  mountSource(app, async () => ({
    scope: { invoke } as unknown as ScopeStub,
    relay: () => ({ controlPlaneUrl: 'https://cp.example', platformSecret: 'secret', tenantId, scopeId, fetchImpl }),
  }));
  const connect = (body: unknown = { companyCode: 'ACME', user: 'ana', password: 'pw', folder: 'Facturas/2026' }) =>
    app.request('/api/source', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { app, calls, invoke, connect, source: () => source };
}

it('connects the space to its own connection, bound to its folder, and records what the connector found', async () => {
  const w = world({ manager: true });
  const res = await w.connect();
  expect(res.status).toBe(200);
  expect(w.calls.map((c) => c.path)).toEqual(['/internal/connections/upsert', '/internal/connections/bind']);
  expect(w.calls[0]!.body).toMatchObject({ tenantId, scopeId, provider: 'canopy.a3doc', owner: 'scope', externalAccountRef: 'ACME', createdBy: 'owner', secret: { companyCode: 'ACME', user: 'ana', password: 'pw' } });
  expect(w.calls[1]!.body).toMatchObject({ connectionId: CONNECTION, options: { folder: 'Facturas/2026' }, boundBy: 'owner' });
  expect(w.source()).toMatchObject({ connectionId: CONNECTION, account: 'ACME', folder: 'Facturas/2026', canUpload: true });
  // The password goes to the relay and nowhere else.
  expect(JSON.stringify(w.invoke.mock.calls)).not.toContain('"pw"');
  expect(await (await w.app.request('/api/source/status')).json()).toMatchObject({ source: { account: 'ACME' }, binding: { status: 'active', lastError: null } });
});

it('unbinds another account before binding the new one, and disconnects', async () => {
  const w = world({ manager: true, prior: { provider: 'canopy.a3doc', connectionId: OTHER, account: 'OLD', folder: '', canUpload: false, boundAt: 'then' } });
  await w.connect();
  expect(w.calls.map((c) => [c.path, c.body.connectionId])).toEqual([
    ['/internal/connections/upsert', undefined], ['/internal/connections/unbind', OTHER], ['/internal/connections/bind', CONNECTION],
  ]);
  expect((await w.app.request('/api/source', { method: 'DELETE' })).status).toBe(204);
  expect(w.calls.at(-1)).toMatchObject({ path: '/internal/connections/unbind', body: { connectionId: CONNECTION, unboundBy: 'owner' } });
  expect(w.source()).toBeNull();
});

it('refuses a non-manager before reaching the platform, and passes on what a3doc refused', async () => {
  const member = world();
  expect((await member.connect()).status).toBe(403);
  expect(member.calls).toEqual([]);
  expect((await world({ manager: true }).connect({ companyCode: 'ACME' })).status).toBe(400);
  const refused = world({ manager: true, refuse: { path: '/internal/connections/bind', status: 409, error: "no a3doc folder at 'Nope'" } });
  const res = await refused.connect();
  expect(res.status).toBe(409);
  expect(await res.text()).toContain("no a3doc folder at 'Nope'");
  expect(refused.source()).toBeNull();
});
