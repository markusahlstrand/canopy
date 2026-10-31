/**
 * AWS Signature Version 4 for S3, over Web Crypto only: no SDK, so the connector runs unchanged on
 * Node and Workers. Every S3-compatible store this targets (AWS, R2, MinIO, Wasabi, B2) accepts it.
 *
 * The payload is always hashed (never `UNSIGNED-PAYLOAD`): a body is at most
 * `FILE_SOURCE_MAX_FILE_BYTES` and is held whole anyway.
 */

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Present only for temporary (STS) credentials. */
  sessionToken?: string;
  region: string;
}

const encoder = new TextEncoder();

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? encoder.encode(data) : data));
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, encoder.encode(data)));
}

/** RFC 3986 unreserved characters pass; everything else is %XX, as SigV4 requires. */
export function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** A key as a URI path: each segment encoded, the slashes kept. */
export const encodePath = (path: string) => path.split('/').map(encodeRfc3986).join('/');

export function canonicalQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

export interface SignInput {
  method: string;
  host: string;
  /** Already encoded with {@link encodePath}; begins with `/`. */
  path: string;
  query: Record<string, string>;
  /** Headers to send and sign, any case. `host` and the `x-amz-*` signing headers are added. */
  headers: Record<string, string>;
  payloadHash: string;
  credentials: S3Credentials;
  now: Date;
}

/**
 * The headers to send: the caller's, plus `x-amz-date`, `x-amz-content-sha256`, the session token
 * and `authorization`. `host` is signed but not returned, since `fetch` sets it itself.
 */
export async function signRequest(input: SignInput): Promise<Record<string, string>> {
  const amzDate = input.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  headers['x-amz-date'] = amzDate;
  headers['x-amz-content-sha256'] = input.payloadHash;
  if (input.credentials.sessionToken) headers['x-amz-security-token'] = input.credentials.sessionToken;
  const signed: Record<string, string> = { ...headers, host: input.host };
  const names = Object.keys(signed).sort();
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.path,
    canonicalQuery(input.query),
    names.map((n) => `${n}:${signed[n]}\n`).join(''),
    names.join(';'),
    input.payloadHash,
  ].join('\n');
  const scope = `${date}/${input.credentials.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  let key = await hmac(encoder.encode(`AWS4${input.credentials.secretAccessKey}`), date);
  for (const part of [input.credentials.region, 's3', 'aws4_request']) key = await hmac(key, part);
  const signature = [...(await hmac(key, stringToSign))].map((b) => b.toString(16).padStart(2, '0')).join('');
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return headers;
}
