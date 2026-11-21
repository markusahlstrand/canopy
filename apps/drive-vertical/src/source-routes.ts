import type { Context, Env, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { connectionId as connectionIdSchema, type ScopeId, type TenantId } from '@substrat-run/contracts';
import type { ScopeStub } from '@substrat-run/kernel';
import { bindConnection, ConnectionRequestError, listBindings, syncConnections, unbindConnection, upsertConnection, type ConnectionRelayAccess } from '@substrat-run/vertical-host';
import { a3docSecret, A3DOC_VERTICAL_PROVIDER } from '@canopy/connector-a3docs';
import { qontoSecret, QONTO_VERTICAL_PROVIDER } from '@canopy/connector-qonto';

export interface DriveSource { provider: string; connectionId: string; account: string; user?: string; folder: string; canUpload: boolean; boundAt: string }

/** What the connector's last full read found; see `A3docSyncReport`. */
export interface SourceSyncReport { at: string; complete: boolean; total: number; read: number; skipped: number; skippedContainers: number[]; files: number }

/** Where one folder of a connected space stands against its source; see `drive/request-folder-refresh`. */
export interface FolderRefresh { folderId: string; path: string; state: 'unchecked' | 'checking' | 'checked' | 'failed'; checkedAt: string | null; error: string | null; changes: number }
/** What asking for a folder check answers: the folder's state, and when to ask again while it is checking. */
export interface FolderRefreshAnswer { refresh: FolderRefresh | null; retryAfterMs?: number }
/** How soon a page showing "Checking…" asks again: cheap, since only `start` reaches the source. */
export const FOLDER_RECHECK_MS = 5_000;

/** What one poll of this space's binding did; `pending` means more is left for a later sync. */
export interface SourceSyncOutcome { outcome: 'landed' | 'unchanged' | 'failed' | 'in-progress'; at: string; pending: boolean; error?: string }

export type SourceRelay = ConnectionRelayAccess & { tenantId: TenantId; scopeId: ScopeId };

/** The a3doc login and the folder under its root this space mirrors (`''` is the root). */
// Bound and reported as `Facturas`, whatever slashes or spaces the user typed around it.
const connectInput = a3docSecret.extend({ folder: z.string().max(500).transform(folder => folder.split('/').map(s => s.trim()).filter(Boolean).join('/')) });

/** What to connect, read from the request. A body naming no provider is an a3doc login. */
function parseConnect(body: unknown) {
  if ((body as { provider?: unknown } | null)?.provider === QONTO_VERTICAL_PROVIDER) {
    const input = qontoSecret.safeParse(body);
    if (!input.success) throw new HTTPException(400, { message: 'Enter the Qonto login and secret key.' });
    return { provider: QONTO_VERTICAL_PROVIDER, label: `Qonto ${input.data.login}`, account: input.data.login, user: undefined, secret: input.data, folder: '' };
  }
  const input = connectInput.safeParse(body);
  if (!input.success) throw new HTTPException(400, { message: 'Enter the a3doc company code, user and password.' });
  const { folder, ...secret } = input.data;
  return { provider: A3DOC_VERTICAL_PROVIDER, label: `a3doc ${secret.companyCode}`, account: secret.companyCode, user: secret.user, secret, folder };
}

/**
 * Connect a space to its own a3doc folder, or disconnect it (#358, substrat#2732).
 *
 * `drive/source-access` decides (it checks `drive:manage`); these routes effect the decision
 * through the platform's connection relay, because module code cannot fetch and a credential must
 * never rest in a scope row. Each space owns its connection: two spaces on one a3doc account hold
 * two connections, each bound to its own folder. The platform's bind asks the connector, which
 * checks the folder exists and reads whether this a3doc user may upload.
 */
export function mountSource<E extends Env>(
  app: Hono<E>,
  resolve: (c: Context<E>) => Promise<{ scope: ScopeStub; relay: () => SourceRelay }>,
  options: {
    folderRefreshMs?: (c: Context<E>) => number | undefined;
    /** Whether the provider's connector answers folder requests itself (`hasFolderChecks`). */
    checksFolders?: (provider: string) => boolean;
  } = {},
) {
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
    const { provider, label, account, user, secret, folder } = parseConnect(await c.req.json().catch(() => null));
    const { principal, source: prior } = await scope.invoke<{ principal: string; source: DriveSource | null }>('drive/source-access');
    const access = relay();
    const { connectionId } = await relayed(() => upsertConnection({
      ...access, provider, owner: 'scope', label,
      externalAccountRef: account, secret, createdBy: principal,
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
          // The bind's own refusal is what the user needs to read; a failed cleanup must not replace it.
          .catch(() => scope.invoke('drive/clear-source').catch(() => {}));
      }
      throw error;
    }
    const source = await scope.invoke<DriveSource>('drive/record-source', {
      provider, connectionId, account, ...(user ? { user } : {}),
      folder: typeof bound.options.folder === 'string' ? bound.options.folder : folder,
      canUpload: bound.options.canUpload === true,
    });
    // The first sync starts now rather than at the platform's next pass, without holding up the
    // answer: the poll reads and lands a whole batch. Best effort; the scheduled pass is the backstop.
    background(c, syncConnections({ ...access, provider }).catch(() => {}));
    return c.json(source);
  });

  /** **Sync now**: poll this space's binding at once and say what the poll did. */
  app.post('/api/source/sync', async (c) => {
    const { scope, relay } = await resolve(c);
    const { source } = await scope.invoke<{ principal: string; source: DriveSource | null }>('drive/source-access');
    if (!source) throw new HTTPException(409, { message: 'This space has no source to sync.' });
    let polled: Awaited<ReturnType<typeof syncConnections>>;
    try {
      polled = await syncConnections({ ...relay(), provider: source.provider });
    } catch (error) {
      if (error instanceof ConnectionRequestError && error.status === 429) {
        // Connecting starts a sync too, so this can be the first one, still running, not the person's own.
        throw new HTTPException(429, { message: 'A sync started less than a minute ago. Try again in a minute.' });
      }
      return relayed(() => Promise.reject(error));
    }
    const mine = polled.bindings.find((b) => b.connectionId === source.connectionId);
    if (!mine) throw new HTTPException(409, { message: 'The platform holds no binding for this space’s source. Connect it again.' });
    const { connectionId: _, ...outcome } = mine;
    return c.json(outcome satisfies SourceSyncOutcome);
  });

  /**
   * Someone opened a folder (or pressed its refresh): check it against the source unless that was
   * done within the throttle or is already under way. The drive decides (`drive/request-folder-refresh`,
   * which needs only read access to the folder); only a `start` polls the source, through the
   * platform, which itself polls a binding at most once a minute. A connector with the folder-check
   * capability reads that folder's children in the poll; any other runs its ordinary pass. Failures
   * are recorded on the folder and answered as its state, never as an error: the listing stands.
   */
  app.post('/api/source/folders/:folderId/refresh', async (c) => {
    const { scope, relay } = await resolve(c);
    const body = await c.req.json().catch(() => ({})) as { force?: unknown };
    const folderId = c.req.param('folderId');
    const throttleMs = options.folderRefreshMs?.(c);
    const asked = await scope.invoke<{ decision: 'start' | 'joined' | 'fresh' | 'unsupported'; provider: string | null; refresh: FolderRefresh | null }>(
      'drive/request-folder-refresh', { folderId, force: body.force === true, ...(throttleMs ? { throttleMs } : {}) },
    );
    const answer = (refresh: FolderRefresh | null): FolderRefreshAnswer =>
      ({ refresh, ...(refresh?.state === 'checking' ? { retryAfterMs: FOLDER_RECHECK_MS } : {}) });
    if (asked.decision !== 'start' || !asked.provider) return c.json(answer(asked.refresh));
    const settle = async (outcome: 'checked' | 'failed', error?: string) =>
      (await scope.invoke<{ refresh: FolderRefresh }>('drive/settle-folder-refresh', { folderId, outcome, ...(error ? { error: error.slice(0, 500) } : {}) })).refresh;
    let polled: Awaited<ReturnType<typeof syncConnections>>;
    try {
      polled = await syncConnections({ ...relay(), provider: asked.provider });
    } catch (error) {
      // Polled within the last minute: the request waits for the pass under way or the next one.
      if (error instanceof ConnectionRequestError && error.status === 429) return c.json(answer(asked.refresh));
      if (error instanceof ConnectionRequestError && error.status === 501) return c.json(answer(await settle('failed', 'This source can\u2019t be checked on request.')));
      const reason = error instanceof HTTPException || error instanceof ConnectionRequestError ? error.message : 'Could not reach the source through the platform.';
      return c.json(answer(await settle('failed', reason)));
    }
    const failed = polled.bindings.find((b) => b.outcome === 'failed');
    if (failed) return c.json(answer(await settle('failed', failed.error ?? 'The source gave no reason.')));
    // Another pass was already running, so nothing read this folder: the request waits for the next.
    if (polled.bindings.length && polled.bindings.every((b) => b.outcome === 'in-progress')) return c.json(answer(asked.refresh));
    // A connector that checks folders answered this one in the poll, or did not take it (a sweep
    // takes only a few): either way the drive's record is the truth, and a poll that went well says
    // nothing about a folder nobody read. Asking again reads it without starting anything: `fresh`
    // with the answer, or `joined` while the request still waits for the next sweep.
    if (options.checksFolders?.(asked.provider)) {
      const now = await scope.invoke<{ refresh: FolderRefresh | null }>('drive/request-folder-refresh', { folderId, ...(throttleMs ? { throttleMs } : {}) });
      return c.json(answer(now.refresh));
    }
    // Any other connector ran its ordinary pass, which is the whole of what a check can be there.
    return c.json(answer(await settle('checked')));
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

/** Keep work running after the answer where the runtime allows it; elsewhere it simply runs on. */
function background(c: Context, work: Promise<unknown>) {
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    // No execution context (Node, tests): the promise still runs, it just isn't awaited.
  }
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
    throw new HTTPException(502, { message: `Could not reach the source through the platform: ${error.message}` });
  }
}
