import type { Context, Env, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { mailInAllowEntry, type MailInAddress, type ScopeId, type TenantId } from '@substrat-run/contracts';
import type { ScopeStub } from '@substrat-run/kernel';
import { mailInAddress, MailInAddressError } from '@substrat-run/vertical-host';

export interface MailRelay { controlPlaneUrl: string; platformSecret: string; tenantId: TenantId; scopeId: ScopeId; fetchImpl?: typeof fetch }

/** What settings shows: the address (when there is one) beside what the drive itself filed. */
export interface SpaceMail { address: MailInAddress | null; connected: boolean; messages: number; lastReceivedAt: string | null }

interface MailAccess { principal: string; connected: boolean; messages: number; lastReceivedAt: string | null }

const changeInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('request'), allowlist: z.array(mailInAllowEntry).max(20).optional() }),
  z.object({ action: z.literal('rotate'), allowlist: z.array(mailInAllowEntry).max(20).optional() }),
  z.object({ action: z.literal('revoke') }),
]);

/**
 * "Email to this space" (#357): the address the platform's mail-in gives a space (substrat#2611).
 *
 * `drive/mail-access` decides (it checks `drive:manage`), and these routes effect it through the
 * platform's relay, which only mints an address for a caller it can prove is this scope's worker.
 * Mail then lands through `drive/receive-mail` as the address's own connection, never as a person.
 */
export function mountMail<E extends Env>(app: Hono<E>, resolve: (c: Context<E>) => Promise<{ scope: ScopeStub; relay: () => MailRelay }>) {
  app.get('/api/mail', async (c) => {
    const { scope, relay } = await resolve(c);
    const { principal, ...drive } = await scope.invoke<MailAccess>('drive/mail-access');
    const address = await relayed(() => mailInAddress({ ...relay(), action: 'get', createdBy: principal }));
    return c.json({ address, ...drive } satisfies SpaceMail);
  });

  app.post('/api/mail', async (c) => {
    const { scope, relay } = await resolve(c);
    const input = changeInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new HTTPException(400, { message: 'An allowlist entry is an address, or @domain for anyone there (at most 20).' });
    const { principal, ...drive } = await scope.invoke<MailAccess>('drive/mail-access');
    // A connected space mirrors its source's folders; mail filed here would sit outside it.
    if (drive.connected && input.data.action !== 'revoke') {
      throw new HTTPException(409, { message: 'This space mirrors a connected source, so it has no folders of its own to file mail into.' });
    }
    const address = await relayed(() => mailInAddress({ ...relay(), ...input.data, createdBy: principal }));
    return c.json({ address, ...drive } satisfies SpaceMail);
  });
}

const USER_REFUSALS = [400, 403, 404, 409, 422];

async function relayed<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof MailInAddressError)) throw error;
    // A refusal is the user's to read (a preview cannot have an address, an allowlist too long);
    // anything else, including the platform rejecting this worker's credentials or rate-limiting
    // it, is the platform's, and says so.
    if (USER_REFUSALS.includes(error.status)) throw new HTTPException(error.status === 404 ? 404 : 409, { message: error.message.replace(/^.*?\(\d+\): /, '') });
    throw new HTTPException(502, { message: `Could not reach the platform's mail service: ${error.message}` });
  }
}
