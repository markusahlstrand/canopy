import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { mountInviteSite } from './invite-site-route';

const HOME = 'scope-home', OTHER = 'scope-other';
const acceptUrl = async (res: Response) => ((await res.json()) as { acceptUrl: string }).acceptUrl;

function harness(opts: { signedIn?: boolean; scope?: string; sites?: { scopeId: string; slug: string }[] }) {
  const authorize = vi.fn(async () => {
    if (!opts.signedIn) throw new HTTPException(401, { message: 'unauthorized' });
  });
  const sites = vi.fn(async () => opts.sites ?? []);
  const target = vi.fn(async () => ({ base: HOME, scope: opts.scope ?? HOME, sites }));
  const mint = vi.fn(async () => undefined);
  const app = new Hono();
  mountInviteSite(app, authorize, target);
  app.post('/api/invites', async (c) => {
    await authorize();
    await mint();
    return c.json({ principal: 'p', acceptUrl: 'https://drive.example/?invite=tok' }, 201);
  });
  app.get('/api/invites', (c) => c.json({ invites: [] }));
  const post = () => app.request('https://drive.example/api/invites', { method: 'POST' });
  return { app, post, authorize, sites, target, mint };
}

describe('invite links name the space they were minted in', () => {
  it('lets the home space invite without a registry row, leaving the link hostname-local', async () => {
    const h = harness({ signedIn: true, scope: HOME, sites: [] });
    const res = await h.post();
    expect(res.status).toBe(201);
    expect(await acceptUrl(res)).toBe('https://drive.example/?invite=tok');
    expect(h.mint).toHaveBeenCalledOnce();
  });

  it('names the home space when it has a slug', async () => {
    const h = harness({ signedIn: true, scope: HOME, sites: [{ scopeId: HOME, slug: 'home' }] });
    const res = await h.post();
    expect(res.status).toBe(201);
    expect(new URL(await acceptUrl(res)).searchParams.get('site')).toBe('home');
  });

  it('names a selected space by its slug', async () => {
    const h = harness({ signedIn: true, scope: OTHER, sites: [{ scopeId: HOME, slug: 'home' }, { scopeId: OTHER, slug: 'other' }] });
    const res = await h.post();
    expect(res.status).toBe(201);
    expect(new URL(await acceptUrl(res)).searchParams.get('site')).toBe('other');
  });

  it('refuses a selected space with no slug before anything is minted', async () => {
    const h = harness({ signedIn: true, scope: OTHER, sites: [{ scopeId: HOME, slug: 'home' }] });
    const res = await h.post();
    expect(res.status).toBe(503);
    expect(h.mint).not.toHaveBeenCalled();
  });

  it('answers an unauthenticated caller 401 without touching the registry', async () => {
    const h = harness({ signedIn: false, scope: OTHER, sites: [] });
    const res = await h.post();
    expect(res.status).toBe(401);
    expect(h.target).not.toHaveBeenCalled();
    expect(h.sites).not.toHaveBeenCalled();
    expect(h.mint).not.toHaveBeenCalled();
  });

  it('leaves listing invites alone', async () => {
    const h = harness({ signedIn: false });
    expect((await h.app.request('https://drive.example/api/invites')).status).toBe(200);
    expect(h.authorize).not.toHaveBeenCalled();
  });
});
