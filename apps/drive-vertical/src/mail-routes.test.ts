import { expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ScopeId, TenantId } from '@substrat-run/contracts';
import type { ScopeStub } from '@substrat-run/kernel';
import { mountMail } from './mail-routes';

const tenantId = '01JZ00000000000000000TEN01' as TenantId, scopeId = '01JZ00000000000000000SC001' as ScopeId;
const CONNECTION = '01JZ00000000000000000C0N01';
const address = (allowlist: string[] = []) => ({
  address: 'mail+drive-k3x9@in.substrat.run', connectionId: CONNECTION, tenantId, scopeId, vertical: 'drive-vertical',
  operation: 'drive/receive-mail', permission: 'drive:receive-mail', allowlist, createdAt: '2026-11-08T10:00:00.000Z', createdBy: 'owner',
  stats: { received: 0, delivered: 0, rejected: 0, deadLettered: 0, pending: 0, lastReceivedAt: null, lastRejectedAt: null, lastRejectReason: null },
});

function world(options: { manager?: boolean; connected?: boolean; has?: boolean; refuse?: number } = {}) {
  let held = options.has ? address() : null;
  const calls: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { action: string; allowlist?: string[] };
    calls.push(body);
    if (options.refuse) return Response.json({ title: 'refused', detail: 'previews cannot have an address' }, { status: options.refuse });
    if (body.action === 'request' || body.action === 'rotate') held = address(body.allowlist);
    if (body.action === 'revoke') held = null;
    return Response.json({ address: held });
  }) as unknown as typeof fetch;
  const invoke = vi.fn(async (operation: string) => {
    if (operation !== 'drive/mail-access') throw new Error(operation);
    if (!options.manager) throw new HTTPException(403);
    return { principal: 'owner', connected: !!options.connected, messages: 3, lastReceivedAt: '2026-11-01T09:00:00.000Z' };
  });
  const app = new Hono();
  mountMail(app, async () => ({
    scope: { invoke } as unknown as ScopeStub,
    relay: () => ({ controlPlaneUrl: 'https://cp.example', platformSecret: 'secret', tenantId, scopeId, fetchImpl }),
  }));
  const post = (body: unknown) => app.request('/api/mail', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { app, calls, post };
}

it('asks the platform for an address with the allowlist, after the drive authorizes it', async () => {
  const w = world({ manager: true });
  const res = await w.post({ action: 'request', allowlist: ['Me@Example.com', '@supplier.example'] });
  expect(res.status).toBe(200);
  expect(w.calls[0]).toMatchObject({ tenantId, scopeId, action: 'request', createdBy: 'owner', allowlist: ['me@example.com', '@supplier.example'] });
  expect(await res.json()).toMatchObject({ address: { address: 'mail+drive-k3x9@in.substrat.run' }, messages: 3 });
});

it('shows, rotates and revokes the address', async () => {
  const w = world({ manager: true, has: true });
  expect(await (await w.app.request('/api/mail')).json()).toMatchObject({ address: { connectionId: CONNECTION }, connected: false });
  expect((await w.post({ action: 'rotate' })).status).toBe(200);
  expect(await (await w.post({ action: 'revoke' })).json()).toMatchObject({ address: null });
  expect(w.calls.map((c) => c.action)).toEqual(['get', 'rotate', 'revoke']);
});

it('refuses non-managers, a bad allowlist and a connected space before reaching the platform', async () => {
  expect((await world().post({ action: 'request' })).status).toBe(403);
  const w = world({ manager: true });
  expect((await w.post({ action: 'request', allowlist: ['not an address'] })).status).toBe(400);
  const connected = world({ manager: true, connected: true });
  expect((await connected.post({ action: 'request' })).status).toBe(409);
  // Revoking still works on a space that became connected after it got an address.
  expect((await connected.post({ action: 'revoke' })).status).toBe(200);
  expect(w.calls).toEqual([]);
});

it("relays the platform's refusal in its own words", async () => {
  const res = await world({ manager: true, refuse: 422 }).post({ action: 'request' });
  expect(res.status).toBe(409);
});

it.each([401, 429])("treats a %i from the platform as the platform's failure, not the user's refusal", async (status) => {
  const res = await world({ manager: true, refuse: status }).post({ action: 'request' });
  expect(res.status).toBe(502);
});
