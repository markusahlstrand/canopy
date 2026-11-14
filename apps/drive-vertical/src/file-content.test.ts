import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bytesStream, resolveByteRange, type AttachmentOpenOptions } from '@substrat-run/kernel';
import { mountFileContent, type FileContentRecord, type OpenedContent } from './file-content';

const SHA = 'a'.repeat(64);

/** The kernel's `openStream`, in memory: a slice for a range, `unsatisfiable` when it holds no byte. */
function opener(text: string, contentType: string, { canSlice = true } = {}) {
  const bytes = new TextEncoder().encode(text);
  return vi.fn(async (_id: string, options?: AttachmentOpenOptions): Promise<OpenedContent> => {
    const record = { sha256: SHA, size: bytes.byteLength };
    if (!options?.range || !canSlice) return { record, contentType, body: bytesStream(bytes) };
    const span = resolveByteRange(options.range, bytes.byteLength);
    if (!span) return { record, contentType, body: bytesStream(new Uint8Array()), range: 'unsatisfiable' };
    return { record, contentType, body: bytesStream(bytes.slice(span.start, span.end + 1)), range: span };
  });
}

const record: FileContentRecord = {
  file: { name: 'draft résumé.txt' },
  version: { source: 'blob', blob_ref: 'old-attachment', mime: 'text/plain' },
};

describe('current and historical content routes', () => {
  it('passes both identities to the read gate and opens only the returned attachment', async () => {
    const getFile = vi.fn(async () => record);
    const openAttachment = opener('first draft', 'text/plain');
    const app = new Hono();
    mountFileContent(app, async () => ({ getFile, openAttachment }));
    const response = await app.request('/api/files/file-a/versions/version-old/content');
    expect(response.status).toBe(200);
    expect(getFile).toHaveBeenCalledWith('file-a', 'version-old');
    expect(openAttachment).toHaveBeenCalledWith('old-attachment', undefined);
    expect(await response.text()).toBe('first draft');
    expect(response.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''draft%20r%C3%A9sum%C3%A9.txt");
    await app.request('/api/files/file-a/content');
    expect(getFile).toHaveBeenLastCalledWith('file-a', undefined);
  });

  it('requires authentication before either read', async () => {
    const app = new Hono();
    mountFileContent(app, async () => null);
    expect((await app.request('/api/files/a/versions/b/content')).status).toBe(401);
  });

  it('does not open bytes when the file/version read refuses access', async () => {
    const openAttachment = vi.fn();
    const app = new Hono();
    mountFileContent(app, async () => ({
      getFile: async () => { throw new HTTPException(403); }, openAttachment,
    }));
    expect((await app.request('/api/files/a/versions/b/content')).status).toBe(403);
    expect(openAttachment).not.toHaveBeenCalled();
  });

  it.each([
    [null, 404],
    [{ source: 'external', blob_ref: null, mime: 'text/plain' }, 501],
  ] as const)('refuses unavailable versions without opening bytes', async (version, status) => {
    const openAttachment = vi.fn();
    const app = new Hono();
    mountFileContent(app, async () => ({ getFile: async () => ({ ...record, version }), openAttachment }));
    expect((await app.request('/api/files/a/versions/b/content')).status).toBe(status);
    expect(openAttachment).not.toHaveBeenCalled();
  });

  it('reports missing historical bytes as 404', async () => {
    const app = new Hono();
    mountFileContent(app, async () => ({ getFile: async () => record, openAttachment: async () => null }));
    expect((await app.request('/api/files/a/versions/b/content')).status).toBe(404);
  });
});

it.each([
  ['bytes=0-1', 206, 'bytes 0-1/10', '01'],
  ['bytes=7-', 206, 'bytes 7-9/10', '789'],
  ['bytes=-3', 206, 'bytes 7-9/10', '789'],
  ['bytes=5-99', 206, 'bytes 5-9/10', '56789'],
  ['bytes=10-', 416, 'bytes */10', ''],
  ['bytes=-0', 416, 'bytes */10', ''],
  // Not a single satisfiable-or-not range: ignored, and the whole file is served (RFC 9110 §14.2).
  ['bytes=2-1', 200, null, '0123456789'],
  ['bytes=0-1,3-4', 200, null, '0123456789'],
  ['items=0-1', 200, null, '0123456789'],
])('serves a range %s read from the store as a slice', async (range, status, contentRange, body) => {
  const openAttachment = opener('0123456789', 'video/mp4');
  const app = new Hono();
  mountFileContent(app, async () => ({ getFile: async () => record, openAttachment }));
  const response = await app.request('/api/files/a/versions/b/content', { headers: { Range: range } });
  expect(response.status).toBe(status);
  expect(response.headers.get('content-range')).toBe(contentRange);
  expect(response.headers.get('accept-ranges')).toBe('bytes');
  expect(response.headers.get('content-length')).toBe(String(body.length));
  expect(await response.text()).toBe(body);
  if (status === 206) expect(openAttachment.mock.calls[0]![1]).toEqual({ range: expect.any(Object) });
});

it('serves the whole file when the store cannot slice', async () => {
  const app = new Hono();
  mountFileContent(app, async () => ({ getFile: async () => record, openAttachment: opener('0123456789', 'video/mp4', { canSlice: false }) }));
  const response = await app.request('/api/files/a/content', { headers: { Range: 'bytes=0-1' } });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-range')).toBeNull();
  expect(await response.text()).toBe('0123456789');
});

it('honours If-Range only when it is the content hash', async () => {
  const app = new Hono();
  mountFileContent(app, async () => ({ getFile: async () => record, openAttachment: opener('0123456789', 'video/mp4') }));
  const matching = await app.request('/api/files/a/content', { headers: { Range: 'bytes=0-1', 'If-Range': `"${SHA}"` } });
  expect(matching.status).toBe(206);
  expect(matching.headers.get('etag')).toBe(`"${SHA}"`);
  for (const ifRange of [`"${'b'.repeat(64)}"`, 'Wed, 21 Oct 2015 07:28:00 GMT']) {
    const stale = await app.request('/api/files/a/content', { headers: { Range: 'bytes=0-1', 'If-Range': ifRange } });
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe('0123456789');
  }
});

it('answers HEAD with the length and no body, without a range', async () => {
  const openAttachment = opener('0123456789', 'video/mp4');
  const app = new Hono();
  mountFileContent(app, async () => ({ getFile: async () => record, openAttachment }));
  const response = await app.request('/api/files/a/content', { method: 'HEAD', headers: { Range: 'bytes=0-1' } });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-length')).toBe('10');
  expect(await response.text()).toBe('');
  expect(openAttachment).toHaveBeenCalledWith('old-attachment', undefined);
});

it.each(['text/html', 'image/svg+xml', 'application/xhtml+xml'])('forces active content %s to download with sandboxing', async contentType => {
  const app = new Hono();
  mountFileContent(app, async () => ({ getFile: async () => record, openAttachment: opener('<script>unsafe</script>', contentType) }));
  const response = await app.request('/api/files/a/content');
  expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('content-security-policy')).toContain('sandbox');
});

it('keeps an inline PDF unsandboxed so the preview can embed it', async () => {
  const app = new Hono();
  mountFileContent(app, async () => ({ getFile: async () => record, openAttachment: opener('%PDF-1.7', 'application/pdf') }));
  const response = await app.request('/api/files/a/content');
  expect(response.headers.get('content-disposition')).toMatch(/^inline;/);
  expect(response.headers.get('content-security-policy')).toBeNull();
});
