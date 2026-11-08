import type { Context, Env, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { connectionId as connectionIdSchema, type ScopeId, type TenantId } from '@substrat-run/contracts';
import type { ScopeStub } from '@substrat-run/kernel';
import { bindConnection, ConnectionRequestError, listBindings, unbindConnection, upsertConnection, type ConnectionRelayAccess } from '@substrat-run/vertical-host';
import { a3docSecret, A3DOC_VERTICAL_PROVIDER } from '@canopy/connector-a3docs';

export interface DriveSource { provider: string; connectionId: string; account: string; folder: string; canUpload: boolean; boundAt: string }

/** What the connector's last full read found; see `A3docSyncReport`. */
export interface SourceSyncReport { at: string; complete: boolean; total: number; read: number; skipped: number; skippedContainers: number[]; files: number }

export type SourceRelay = ConnectionRelayAccess & { tenantId: TenantId; scopeId: ScopeId };

/** The a3doc login and the folder under its root this space mirrors (`''` is the root). */
const connectInput = a3docSecret.extend({ folder: z.string().trim().max(500) });

/**
 * Connect a space to its own a3doc folder, or disconnect it (#358, substrat#2732).
 *
 * `drive/source-access` decides (it checks `drive:manage`); these routes effect the decision
 * through the platform's connection relay, because module code cannot fetch and a credential must
 * never rest in a scope row. Each space owns its connection: two spaces on one a3doc account hold
 * two connections, each bound to its own folder. The platform's bind asks the connector, which
 * checks the folder exists and reads whether this a3doc user may upload.
 */
export function mountSource<E extends Env>(app: Hono<E>, resolve: (c: Context<E>) => Promise<{ scope: ScopeStub; relay: () => SourceRelay }>) {
  app.get('/api/source/status', async (c) => {
    const { scope, relay } = await resolve(c);
    const { source, report } = await scope.invoke<{ source: DriveSource | null; report?: SourceSyncReport }>('drive/get-source');
    if (!source) return c.json({ source: null, binding: null, report: null });
    const { bindings } = await relayed(() => listBindings(relay()));
    const binding = bindings.find((b) => b.connectionId === source.connectionId) ?? null;
    return c.json({ source, binding: binding && { status: binding.status, lastSyncedAt: binding.lastSyncedAt, lastError: binding.lastError }, report: report ?? null });
  });

  app.put('/api/source', async (c) => {
    const { scope, relay } = await resolve(c);
    const input = connectInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new HTTPException(400, { message: 'Enter the a3doc company code, user and password.' });
    const { folder, ...secret } = input.data;
    const { principal, source: prior } = await scope.invoke<{ principal: string; source: DriveSource | null }>('drive/source-access');
    const access = relay();
    const { connectionId } = await relayed(() => upsertConnection({
      ...access, provider: A3DOC_VERTICAL_PROVIDER, owner: 'scope', label: `a3doc ${secret.companyCode}`,
      externalAccountRef: secret.companyCode, secret, createdBy: principal,
    }));
    // A space mirrors one folder: another account's binding goes before this one is made.
    const replaced = prior && prior.connectionId !== connectionId ? prior : null;
    if (replaced) {
      await relayed(() => unbindConnection({ ...access, connectionId: connectionIdSchema.parse(replaced.connectionId), unboundBy: principal }));
    }
    let bound: Awaited<ReturnType<typeof bindConnection>>;
    try {
      bound = await relayed(() => bindConnection({ ...access, connectionId, options: { folder }, boundBy: principal }));
    } catch (error) {
      // The space must not keep recording a source nothing binds any more: put the previous
      // account back on its folder, or, when even that fails, record no source at all.
      if (replaced) {
        await relayed(() => bindConnection({ ...access, connectionId: connectionIdSchema.parse(replaced.connectionId), options: { folder: replaced.folder }, boundBy: principal }))
          .catch(() => scope.invoke('drive/clear-source'));
      }
      throw error;
    }
    const source = await scope.invoke<DriveSource>('drive/record-source', {
      provider: A3DOC_VERTICAL_PROVIDER, connectionId, account: secret.companyCode,
      folder: typeof bound.options.folder === 'string' ? bound.options.folder : folder,
      canUpload: bound.options.canUpload === true,
    });
    return c.json(source);
  });

  app.delete('/api/source', async (c) => {
    const { scope, relay } = await resolve(c);
    const { principal, source } = await scope.invoke<{ principal: string; source: DriveSource | null }>('drive/source-access');
    if (source) {
      await relayed(() => unbindConnection({ ...relay(), connectionId: connectionIdSchema.parse(source.connectionId), unboundBy: principal }));
      await scope.invoke('drive/clear-source');
    }
    return c.body(null, 204);
  });
}

/** The relay's refusal in its own words: a credential a3doc rejected or a folder it lacks is the caller's to fix. */
async function relayed<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof ConnectionRequestError)) throw error;
    const status = error.status === 409 || error.status === 422 ? error.status : 502;
    // A refusal is the user's to read; anything else keeps which relay call failed and its status,
    // since "unknown error" alone cannot tell a platform crash from an answer that would not parse.
    if (status !== 502) throw new HTTPException(status, { message: error.message.replace(/^.*?\(\d+\): /, '') });
    throw new HTTPException(502, { message: `Could not reach a3doc through the platform: ${error.message}` });
  }
}
