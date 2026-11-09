import type { ConnectorDefinition } from '@substrat-run/vertical-host/connectors';
import type { QontoSecret } from './client.js';
import { probeQontoSecret } from './probe.js';
import { bindQontoContext, syncQontoContext, type QontoSyncOptions } from './sync.js';

/** A vertical-owned provider; the platform distinguishes it from first-party connector slugs. */
export const QONTO_VERTICAL_PROVIDER = 'canopy.qonto';

/** Hosted definition: read-only, so it has no events and no dispatch. */
export function qontoConnectorDefinition(config: Pick<QontoSyncOptions, 'apiBase' | 'now'> = {}): ConnectorDefinition {
  const apiBase = config.apiBase ? { apiBase: config.apiBase } : {};
  return {
    label: 'Qonto',
    description: 'Transactions, receipts, invoices and statements from a Qonto business account.',
    monogram: 'Q',
    fields: [
      { key: 'login', label: 'Login', secret: false },
      { key: 'secretKey', label: 'Secret key', secret: true },
    ] satisfies { key: keyof QontoSecret; label: string; secret: boolean }[],
    // Attachments use the drive's ordinary write permission; landing itself is granted by the binding.
    grants: ['drive:write'],
    probeCandidate: (secret, io) => probeQontoSecret(secret, { fetch: io.fetch, ...apiBase }),
    probe: (ctx) => probeQontoSecret({ ...ctx.secret }, { fetch: ctx.fetch, ...apiBase }),
    bind: (ctx, binding) => bindQontoContext({ ...ctx, scope: { ...ctx.scope, options: binding } }, config),
    sweep: async (ctx) => {
      const result = await syncQontoContext(ctx, config);
      return { landed: result.changes, more: !result.complete };
    },
  };
}
