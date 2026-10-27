import type { ConnectorDefinition } from '@substrat-run/vertical-host/connectors';
import { ConnectorRefusal } from '@substrat-run/kernel';
import { bindA3docContext, dispatchA3docContext, syncA3docContext, A3DOC_FILES_EVENT } from './files.js';
import { probeA3docSecret } from './probe.js';
import type { A3docOptions } from './connection.js';

/** A vertical-owned provider; the platform distinguishes it from first-party connector slugs. */
export const A3DOC_VERTICAL_PROVIDER = 'canopy.a3doc';

/** Hosted definition: credentials, fetch and scope authority come only from the platform. */
export function a3docConnectorDefinition(
  config: { journalOperation: string } & Partial<Pick<A3docOptions, 'apiBase' | 'addressProvider' | 'now'>>,
): ConnectorDefinition {
  const options = (fetch: A3docOptions['fetch']) => ({ ...config, fetch });
  return {
    label: 'a3doc', description: 'Documents shared by your gestoría through Wolters Kluwer a3doc.', monogram: 'a3',
    fields: [
      { key: 'companyCode', label: 'Company code', secret: false },
      { key: 'user', label: 'User', secret: false },
      { key: 'password', label: 'Password', secret: true },
      { key: 'customerId', label: 'Customer NIF/CIF for uploads', secret: false, optional: true },
    ],
    // Attachments use the drive's ordinary write permission; landing itself is granted by the binding.
    grants: ['drive:write'], events: [A3DOC_FILES_EVENT],
    probeCandidate: (secret, io) => probeA3docSecret({ ...secret }, options(io.fetch)),
    probe: (ctx) => probeA3docSecret({ ...ctx.secret }, options(ctx.fetch)),
    bind: (ctx, binding) => bindA3docContext({ ...ctx, scope: { ...ctx.scope, options: binding } }, options(ctx.fetch)),
    sweep: async (ctx) => {
      const result = await syncA3docContext(ctx, options(ctx.fetch));
      return { landed: result.changes, more: !result.complete };
    },
    dispatch: async (ctx, event) => {
      if (ctx.scope.options.canUpload !== true) throw new ConnectorRefusal('This a3doc user may only read.');
      await dispatchA3docContext(ctx, event, options(ctx.fetch), config.journalOperation);
    },
  };
}
