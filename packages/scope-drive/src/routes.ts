/**
 * The drive's HTTP API, derived from the declared operations — adapter- and
 * auth-agnostic, so both entrypoints mount the same table and a route cannot exist
 * on one host and 404 on the other.
 *
 * There is no route table written here on purpose: every line of one would restate
 * what `spec/model.ts` already declares — the method, the path, which fields the
 * path carries, and how a paged read puts its entries on the wire with the walk in
 * a `Link` header. `mountOperations` derives all of it from each operation's `http`.
 */
import type { Context, Hono } from 'hono';
import { mountOperations, problemResponse, type ResolveStub } from '@substrat-run/vertical-host';
import { driveOperations } from '../spec/model.js';

export type { ResolveStub };

export function mountApi(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  resolveStub: ResolveStub,
): { operation: string; method: string; path: string }[] {
  // One error vocabulary: a permission denial is 403, a missing thing 404, a broken
  // invariant 409 — the same classification the platform surface uses.
  app.onError((err, c: Context) => problemResponse(c, err));
  return mountOperations(app, driveOperations, resolveStub);
}
