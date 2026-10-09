import type { Context, Env, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

export type InviteSiteTarget = {
  base: string;
  scope: string;
  sites: () => Promise<{ scopeId: string; slug: string }[]>;
};

/**
 * The shared invite route builds a hostname-local link, which reaches the hostname's home
 * space only. A link minted in another selected space must also name it with `?site=`.
 *
 * The gate runs first, so a refused caller gets its 401/403 and never triggers the registry
 * lookup. A selected space with no slug is refused BEFORE the invite is minted: a live invite
 * with a link that lands in the wrong space is worse than no invite. The home space never
 * needs a slug, but gets one when it has one, because the recipient's browser may have a
 * stored selection that would otherwise outrank the hostname.
 */
export function mountInviteSite<E extends Env>(
  app: Hono<E>,
  authorize: (c: Context<E>) => Promise<unknown>,
  target: (c: Context<E>) => Promise<InviteSiteTarget>,
) {
  app.use('/api/invites', async (c, next) => {
    if (c.req.method !== 'POST') return next();
    await authorize(c);
    const { base, scope, sites } = await target(c);
    const site = (await sites()).find((site) => site.scopeId === scope);
    if (!site) {
      if (scope === base) return next();
      throw new HTTPException(503, { message: 'This space has no invite address yet. Refresh and try again.' });
    }
    await next();
    if (c.res.status !== 201) return;
    const body = (await c.res.clone().json()) as { acceptUrl: string };
    const link = new URL(body.acceptUrl);
    link.searchParams.set('site', site.slug);
    const headers = new Headers(c.res.headers);
    headers.delete('content-length');
    c.res = new Response(JSON.stringify({ ...body, acceptUrl: link.toString() }), { status: 201, headers });
  });
}
