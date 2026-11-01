import type { ConnectorDefinition } from '@substrat-run/vertical-host/connectors';
import { probeS3Secret, type S3Options } from './connection.js';
import { bindS3Context, dispatchS3Context, syncS3Context, S3_FILES_EVENT, S3_ITEMS_EVENT } from './files.js';

/** A vertical-owned provider; the platform distinguishes it from first-party connector slugs. */
export const S3_VERTICAL_PROVIDER = 'canopy.s3';

/**
 * Hosted definition: credentials, fetch and scope authority come only from the platform.
 * `journalOperation` is the vertical's durable key/value operation: a move records the ids it
 * carries over there, because call-state is committed only when a call succeeds and a move that
 * copied half its objects must not lose them.
 */
export function s3ConnectorDefinition(config: { journalOperation: string } & S3Options): ConnectorDefinition {
  return {
    label: 'S3 bucket',
    description: 'Files in an S3-compatible bucket: AWS S3, Cloudflare R2, MinIO, Wasabi, Backblaze B2.',
    monogram: 'S3',
    fields: [
      { key: 'bucket', label: 'Bucket', secret: false },
      { key: 'accessKeyId', label: 'Access key ID', secret: false },
      { key: 'secretAccessKey', label: 'Secret access key', secret: true },
      { key: 'region', label: 'Region', secret: false, placeholder: 'us-east-1 (auto for R2)', optional: true },
      { key: 'endpoint', label: 'Endpoint', secret: false, placeholder: 'Blank for AWS; https://<account>.r2.cloudflarestorage.com', optional: true },
    ],
    // Attachments use the drive's ordinary write permission; landing itself is granted by the binding.
    grants: ['drive:write'],
    events: [S3_FILES_EVENT, S3_ITEMS_EVENT],
    probeCandidate: (secret, io) => probeS3Secret(secret, io.fetch, config),
    probe: (ctx) => probeS3Secret(ctx.secret, ctx.fetch, config),
    bind: (ctx, options) => bindS3Context({ ...ctx, scope: { ...ctx.scope, options } }, config),
    sweep: async (ctx) => {
      const result = await syncS3Context(ctx, config);
      return { landed: result.changes, more: !result.complete };
    },
    dispatch: (ctx, event) => dispatchS3Context(ctx, event, config),
  };
}
