import { z } from 'zod';
import { connectionProbe, type ConnectionProbe } from '@substrat-run/contracts';
import type { FetchLike } from '@substrat-run/kernel';
import { createS3Client, CREDENTIAL_CODES, S3Error, type S3Client } from './client.js';

/**
 * The credential a tenant types into the connection's door: an access key for one bucket. The
 * bucket is part of the credential, not the binding, because keys are usually scoped to a bucket
 * and the probe can then say whether this key can actually list it.
 */
export const s3Secret = z.object({
  accessKeyId: z.string().trim().min(1).max(256),
  secretAccessKey: z.string().min(1).max(512),
  bucket: z.string().trim().min(1).max(255),
  /** `auto` for R2. Blank = `us-east-1`, AWS's default. */
  region: z.string().trim().max(64).optional().transform((r) => r || 'us-east-1'),
  /** Blank = AWS. Anything else (R2, MinIO, Wasabi, B2) is addressed path-style. */
  endpoint: z
    .string()
    .trim()
    .max(512)
    .optional()
    .transform((e) => e || undefined)
    .refine((e) => e === undefined || /^https?:\/\/[^/\s?#]+(\/[^\s?#]*)?$/i.test(e), 'endpoint must be an http(s) URL without a query or fragment'),
});
export type S3Secret = z.infer<typeof s3Secret>;

export interface S3Options {
  now?: () => Date;
}

export const nowOf = (o: S3Options) => (o.now ? o.now() : new Date());

export function clientFor(fetch: FetchLike, secret: S3Secret, options: S3Options = {}): S3Client {
  return createS3Client({ config: secret, fetch, ...(options.now ? { now: options.now } : {}) });
}

/** Check a credential: list one key of the bucket. Used both before it is stored and on the live connection. */
export async function probeS3Secret(raw: Readonly<Record<string, string>>, fetch: FetchLike, options: S3Options = {}): Promise<ConnectionProbe> {
  const parsed = s3Secret.safeParse({ ...raw });
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    return probeOf({ ok: false, refused: true, error: `incomplete credential: ${fields}` });
  }
  const secret = parsed.data;
  try {
    await clientFor(fetch, secret, options).list({ maxKeys: 1 });
  } catch (e) {
    // S3 refusing the key or naming the bucket wrong is a definite answer; a timeout is not.
    const refused = e instanceof S3Error && (CREDENTIAL_CODES.has(e.code) || e.status === 403);
    return probeOf({ ok: false, refused, error: messageOf(e) });
  }
  return probeOf({
    ok: true,
    accountRef: `${secret.endpoint ?? 's3'}/${secret.bucket}`.slice(0, 200),
    accountLabel: secret.bucket,
    facts: [
      { label: 'Bucket', value: secret.bucket },
      { label: 'Region', value: secret.region },
      { label: 'Endpoint', value: secret.endpoint ?? 'AWS S3' },
    ],
  });
}

export const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 600);

function probeOf(p: Partial<ConnectionProbe> & { ok: boolean }): ConnectionProbe {
  return connectionProbe.parse({ refused: false, accountRef: null, accountLabel: null, facts: [], error: null, ...p });
}
