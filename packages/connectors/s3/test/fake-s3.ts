/** An in-memory S3 behind `fetch`, path-style at {@link ENDPOINT}: just the calls the connector makes. */
export const ENDPOINT = 'http://s3.test';
export const BUCKET = 'family';
export const ACCESS = 'AKIDTEST';
export const SECRET = 'secret-test';

interface Obj { body: Uint8Array; etag: string; modified: string; meta: Record<string, string>; contentType: string }

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class FakeS3 {
  objects = new Map<string, Obj>();
  calls: { method: string; key: string | null }[] = [];
  /** Answer 403 to everything: a wrong key. */
  deny = false;
  /** One-shot faults: the first matching request fails as a lost connection. */
  faults: ((method: string, key: string | null) => boolean)[] = [];
  /** Every Host the requests were addressed to. */
  hosts: string[] = [];
  private n = 0;

  put(key: string, content: string | Uint8Array, meta: Record<string, string> = {}) {
    const body = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    this.objects.set(key, { body, etag: `etag-${++this.n}`, modified: new Date(Date.UTC(2026, 9, 1, 0, 0, this.n)).toISOString(), meta, contentType: 'application/octet-stream' });
  }

  text(key: string) {
    const o = this.objects.get(key);
    return o ? new TextDecoder().decode(o.body) : undefined;
  }

  fetch = async (input: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Response> => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const headers = init.headers ?? {};
    const [, bucket, ...rest] = url.pathname.split('/');
    const key = rest.length ? rest.map(decodeURIComponent).join('/') : null;
    this.calls.push({ method, key: key || null });
    this.hosts.push(url.host);
    const fault = this.faults.findIndex((f) => f(method, key || null));
    if (fault >= 0) {
      this.faults.splice(fault, 1);
      throw new Error('connection reset');
    }
    if (!headers.authorization?.includes(`Credential=${ACCESS}/`)) return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
    if (this.deny) return new Response('<Error><Code>InvalidAccessKeyId</Code><Message>no such key</Message></Error>', { status: 403 });
    if (decodeURIComponent(bucket ?? '') !== BUCKET) return new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 });

    if (!key) return this.list(url.searchParams);
    const obj = this.objects.get(key);
    if (method === 'HEAD' || method === 'GET') {
      if (!obj) return new Response(method === 'GET' ? '<Error><Code>NoSuchKey</Code></Error>' : null, { status: 404 });
      if (headers['if-match'] && headers['if-match'] !== `"${obj.etag}"`) return new Response(null, { status: 412 });
      const h: Record<string, string> = { etag: `"${obj.etag}"`, 'content-length': String(obj.body.length), 'last-modified': new Date(obj.modified).toUTCString(), 'content-type': obj.contentType };
      for (const [k, v] of Object.entries(obj.meta)) h[`x-amz-meta-${k}`] = v;
      return new Response(method === 'GET' ? obj.body : null, { status: 200, headers: h });
    }
    if (method === 'DELETE') {
      this.objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (method === 'PUT') {
      const source = headers['x-amz-copy-source'];
      if (source) {
        const from = source.split('/').slice(2).map(decodeURIComponent).join('/');
        const src = this.objects.get(from);
        if (!src) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
        // A single-part object keeps its ETag (its MD5) through a copy.
        this.objects.set(key, { ...src });
        return new Response('<CopyObjectResult/>', { status: 200 });
      }
      if (headers['if-none-match'] === '*' && obj) return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 });
      const meta: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) if (k.startsWith('x-amz-meta-')) meta[k.slice(11)] = v;
      this.put(key, new Uint8Array(init.body as Uint8Array), meta);
      return new Response(null, { status: 200, headers: { etag: `"${this.objects.get(key)!.etag}"` } });
    }
    return new Response(null, { status: 405 });
  };

  private list(q: URLSearchParams): Response {
    const prefix = q.get('prefix') ?? '';
    const after = q.get('continuation-token') ?? q.get('start-after') ?? '';
    const max = Number(q.get('max-keys') ?? 1000);
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
    const page = keys.slice(0, max);
    const truncated = keys.length > max;
    const contents = page.map((k) => {
      const o = this.objects.get(k)!;
      return `<Contents><Key>${xml(k)}</Key><LastModified>${o.modified}</LastModified><ETag>&quot;${o.etag}&quot;</ETag><Size>${o.body.length}</Size></Contents>`;
    });
    const body = `<?xml version="1.0"?><ListBucketResult><IsTruncated>${truncated}</IsTruncated>${contents.join('')}${truncated ? `<NextContinuationToken>${xml(page.at(-1)!)}</NextContinuationToken>` : ''}</ListBucketResult>`;
    return new Response(body, { status: 200 });
  }
}
