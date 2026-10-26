import { z } from 'zod';
import { tenantId as tenantIdSchema } from '@substrat-run/contracts';
import { deadlineFetch, settleConnectionUse, type FetchLike, type HostAdmin } from '@substrat-run/kernel';
import { createA3docClient, type A3docClient } from './client.js';

/** The provider slug: what connection rows, dispatch kinds and grants are keyed by. */
export const A3DOC_PROVIDER = 'a3doc';

/**
 * The credential a tenant types into the connection's door: the a3doc login itself. a3doc has no
 * API keys or OAuth; its own web app signs in with exactly these three.
 */
export const a3docSecret = z.object({
  companyCode: z.string().trim().min(1).max(64),
  user: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(200),
  /**
   * The customer (NIF/CIF) uploads are filed under. Optional: absent, the connector uses the one
   * the bound folder's documents already carry.
   */
  customerId: z.string().trim().min(1).max(32).optional(),
});
export type A3docSecret = z.infer<typeof a3docSecret>;

export interface A3docOptions {
  fetch: FetchLike;
  /** Overrides for a test deployment pointed at a stub. Unset = a3doc's real hosts. */
  addressProvider?: string;
  apiBase?: string;
  now?: () => Date;
  timeoutMs?: number;
}

/** Which connection: a row, or the ids a binding recorded. */
export type ConnectionRef = { id: string; tenantId: string; vertical: string };

export const nowOf = (o: Pick<A3docOptions, 'now'>) => (o.now ? o.now() : new Date());

/** A client over `fetch` for this credential. */
export function clientFor(fetchImpl: FetchLike, secret: A3docSecret, options: A3docOptions): A3docClient {
  return createA3docClient({
    credentials: { companyCode: secret.companyCode, user: secret.user, password: secret.password },
    fetch: fetchImpl,
    ...(options.apiBase ? { apiBase: options.apiBase } : {}),
    ...(options.addressProvider ? { addressProvider: options.addressProvider } : {}),
  });
}

export async function openSecret(admin: HostAdmin, connection: ConnectionRef) {
  const open = await admin.openConnection(tenantIdSchema.parse(connection.tenantId), connection.vertical, A3DOC_PROVIDER);
  if (!open) {
    throw new Error(`no live '${A3DOC_PROVIDER}' connection for tenant ${connection.tenantId} / vertical '${connection.vertical}'`);
  }
  // The row the caller named and the credential opened must be the same connection.
  if (open.id !== connection.id) {
    throw new Error(`connection ${connection.id} is not the live '${A3DOC_PROVIDER}' connection (${open.id}) for this tenant`);
  }
  return { open, secret: a3docSecret.parse(open.secret) };
}

/** The live connection, its parsed secret, and a client whose every call records health against it. */
export async function openA3docConnection(admin: HostAdmin, options: A3docOptions, connection: ConnectionRef) {
  const { open, secret } = await openSecret(admin, connection);
  const bounded = deadlineFetch(options.fetch, options.timeoutMs ?? 15_000);
  type Settled = Parameters<typeof settleConnectionUse>[2];
  const record = (durationMs: number, settled: Settled) =>
    admin.recordConnectionUse(open.id, settleConnectionUse(A3DOC_PROVIDER, durationMs, settled));
  const fetchImpl: FetchLike = async (input, init) => {
    const started = Date.now();
    try {
      const res = await bounded(input, init);
      await record(Date.now() - started, { response: res });
      return res;
    } catch (err) {
      await record(Date.now() - started, { error: err });
      throw err;
    }
  };
  return { id: open.id, secret, fetch: fetchImpl, client: clientFor(fetchImpl, secret, options) };
}

export type OpenedA3doc = Awaited<ReturnType<typeof openA3docConnection>>;
