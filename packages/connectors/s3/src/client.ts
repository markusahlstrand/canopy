/**
 * A dependency-free S3 client: the handful of calls a file source needs (ListObjectsV2, HEAD, GET,
 * PUT, CopyObject, DELETE), signed with SigV4 over the `fetch` it is handed.
 *
 * Addressing: with no `endpoint` it talks to AWS, virtual-hosted (`<bucket>.s3.<region>.amazonaws.com`),
 * except for a bucket with a dot in its name, which breaks the wildcard certificate and goes
 * path-style. A custom `endpoint` (R2, MinIO, Wasabi, B2) is always path-style
 * (`<endpoint>/<bucket>/<key>`), which every one of them serves.
 */
import type { FetchLike } from '@substrat-run/kernel';
import { EMPTY_SHA256, encodePath, encodeRfc3986, sha256Hex, signRequest, type S3Credentials } from './sigv4.js';

export interface S3Config extends S3Credentials {
  bucket: string;
  /** `https://<account>.r2.cloudflarestorage.com`, `http://localhost:9000`, … Unset = AWS. */
  endpoint?: string;
}

export interface S3Object {
  key: string;
  size: number;
  /** Without the quotes S3 wraps it in. */
  etag: string;
  /** ISO 8601. */
  lastModified: string;
}

export interface S3Head {
  size: number;
  etag: string;
  lastModified: string | null;
  contentType: string | null;
  /** The `x-amz-meta-*` headers asked for, by the name after the prefix. */
  meta: Record<string, string>;
}

/** S3 answering with an error: a definite answer about the request (bad key, no bucket, denied). */
export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'S3Error';
  }
}

/** The codes that say the credential or the bucket is wrong, not that the request was unlucky. */
export const CREDENTIAL_CODES = new Set([
  'AccessDenied',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'NoSuchBucket',
  'InvalidBucketName',
  'AuthorizationHeaderMalformed',
  'PermanentRedirect',
  'InvalidToken',
  'ExpiredToken',
]);

export interface ListInput {
  prefix?: string;
  /** Resume strictly after this key: a cursor that survives a lost continuation token. */
  startAfter?: string;
  continuationToken?: string;
  maxKeys?: number;
  delimiter?: string;
}

export interface ListResult {
  objects: S3Object[];
  prefixes: string[];
  truncated: boolean;
  nextContinuationToken?: string;
}

export interface S3Client {
  list(input: ListInput): Promise<ListResult>;
  /** `metaKeys`: the `x-amz-meta-*` names to read back (a response's headers can only be asked by name). */
  head(key: string, metaKeys?: string[]): Promise<S3Head | null>;
  /**
   * `ifMatch`: only the object with this ETag. Changed since (412) reads as `null`, as gone does: an
   * object that grew after its listing is never buffered past the size the listing was checked at.
   */
  get(key: string, ifMatch?: string): Promise<Uint8Array | null>;
  /** `ifNoneMatch` makes it create-only; a taken key throws an {@link S3Error} with status 412. */
  put(key: string, body: Uint8Array, opts?: { contentType?: string; ifNoneMatch?: boolean; meta?: Record<string, string> }): Promise<{ etag: string | null }>;
  copy(from: string, to: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const unquote = (etag: string) => etag.replace(/^(W\/)?"|"$/g, '');

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()]!,
  );
}

/** The text of every `<tag>` directly inside `xml`, in order. S3's XML has no attributes we read. */
function all(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1]!);
  return out;
}
const one = (xml: string, tag: string) => all(xml, tag)[0];

export function parseListResult(xml: string): ListResult {
  const objects = all(xml, 'Contents').map((c) => ({
    key: decodeXml(one(c, 'Key') ?? ''),
    size: Number(one(c, 'Size') ?? 0),
    etag: unquote(decodeXml(one(c, 'ETag') ?? '')),
    lastModified: new Date(one(c, 'LastModified') ?? 0).toISOString(),
  }));
  const prefixes = all(xml, 'CommonPrefixes').map((p) => decodeXml(one(p, 'Prefix') ?? ''));
  const token = one(xml, 'NextContinuationToken');
  return { objects, prefixes, truncated: one(xml, 'IsTruncated') === 'true', ...(token ? { nextContinuationToken: decodeXml(token) } : {}) };
}

async function errorOf(status: number, body: string): Promise<S3Error> {
  const code = decodeXml(one(body, 'Code') ?? '') || (status === 404 ? 'NotFound' : status === 412 ? 'PreconditionFailed' : `HTTP${status}`);
  const message = decodeXml(one(body, 'Message') ?? '') || `S3 answered ${status}`;
  return new S3Error(status, code, `${code}: ${message}`.slice(0, 600));
}

export function createS3Client(opts: { config: S3Config; fetch: FetchLike; now?: () => Date }): S3Client {
  const { config } = opts;
  const now = () => (opts.now ? opts.now() : new Date());
  const custom = config.endpoint?.replace(/\/+$/, '');
  const pathStyle = !!custom || config.bucket.includes('.');
  const origin = custom ?? (pathStyle ? `https://s3.${config.region}.amazonaws.com` : `https://${config.bucket}.s3.${config.region}.amazonaws.com`);
  // `scheme://host[:port]` and whatever path the endpoint itself carries (`URL` is not assumed).
  const [, scheme = 'https', authority = '', endpointPath = ''] = /^(https?):\/\/([^/]+)(\/.*)?$/i.exec(origin) ?? [];
  // `fetch` drops a default port from the Host header it sends, so the signed host must too.
  const host = authority.replace(scheme.toLowerCase() === 'https' ? /:443$/ : /:80$/, '');
  const site = `${scheme}://${host}`;
  /** The bucket's own path prefix on this origin. */
  const base = `${endpointPath.replace(/\/+$/, '')}${pathStyle ? `/${encodeRfc3986(config.bucket)}` : ''}`;

  async function send(method: string, key: string | null, init: { query?: Record<string, string>; headers?: Record<string, string>; body?: Uint8Array } = {}) {
    const path = key === null ? `${base}/` : `${base}/${encodePath(key)}`;
    const query = init.query ?? {};
    const payloadHash = init.body ? await sha256Hex(init.body) : EMPTY_SHA256;
    const headers = await signRequest({ method, host, path: path || '/', query, headers: init.headers ?? {}, payloadHash, credentials: config, now: now() });
    const qs = Object.keys(query).length ? `?${Object.entries(query).map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join('&')}` : '';
    return opts.fetch(`${site}${path || '/'}${qs}`, { method, headers, ...(init.body ? { body: init.body } : {}) });
  }

  const header = (res: Awaited<ReturnType<FetchLike>>, name: string) => res.headers?.get(name) ?? null;

  return {
    async list(input) {
      const query: Record<string, string> = { 'list-type': '2' };
      if (input.prefix) query.prefix = input.prefix;
      if (input.startAfter) query['start-after'] = input.startAfter;
      if (input.continuationToken) query['continuation-token'] = input.continuationToken;
      if (input.maxKeys) query['max-keys'] = String(input.maxKeys);
      if (input.delimiter) query.delimiter = input.delimiter;
      const res = await send('GET', null, { query });
      const body = await res.text();
      if (!res.ok) throw await errorOf(res.status, body);
      return parseListResult(body);
    },

    async head(key, metaKeys = []) {
      const res = await send('HEAD', key);
      if (res.status === 404) return null;
      if (!res.ok) throw await errorOf(res.status, '');
      const meta: Record<string, string> = {};
      for (const name of metaKeys) {
        const value = header(res, `x-amz-meta-${name}`);
        if (value !== null) meta[name] = value;
      }
      const modified = header(res, 'last-modified');
      return {
        size: Number(header(res, 'content-length') ?? 0),
        etag: unquote(header(res, 'etag') ?? ''),
        lastModified: modified ? new Date(modified).toISOString() : null,
        contentType: header(res, 'content-type'),
        meta,
      };
    },

    async get(key, ifMatch) {
      const res = await send('GET', key, ifMatch ? { headers: { 'if-match': `"${ifMatch}"` } } : {});
      if (res.status === 404 || res.status === 412) return null;
      if (!res.ok) throw await errorOf(res.status, await res.text());
      return new Uint8Array(await res.arrayBuffer());
    },

    async put(key, body, o = {}) {
      const headers: Record<string, string> = {};
      if (o.contentType) headers['content-type'] = o.contentType;
      if (o.ifNoneMatch) headers['if-none-match'] = '*';
      for (const [k, v] of Object.entries(o.meta ?? {})) headers[`x-amz-meta-${k}`] = v;
      const res = await send('PUT', key, { headers, body });
      if (!res.ok) throw await errorOf(res.status, await res.text());
      const etag = header(res, 'etag');
      return { etag: etag ? unquote(etag) : null };
    },

    async copy(from, to) {
      const res = await send('PUT', to, { headers: { 'x-amz-copy-source': `/${encodeRfc3986(config.bucket)}/${encodePath(from)}` } });
      const body = await res.text();
      // CopyObject can answer 200 and still have failed: the error is in the body.
      if (!res.ok || /<Error>/.test(body)) throw await errorOf(res.ok ? 500 : res.status, body);
    },

    async delete(key) {
      const res = await send('DELETE', key);
      // S3 answers 204 for a key that was never there, so a repeat is harmless.
      if (!res.ok && res.status !== 404) throw await errorOf(res.status, await res.text());
    },
  };
}
