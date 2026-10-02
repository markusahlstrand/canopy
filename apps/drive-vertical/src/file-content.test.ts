import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { mountFileContent, type FileContentRecord } from './file-content';

const record: FileContentRecord = {
  file: { name: 'draft résumé.txt' },
  version: { source: 'blob', blob_ref: 'old-attachment', mime: 'text/plain' },
};

describe('current and historical content routes', () => {
  it('passes both identities to the read gate and opens only the returned attachment', async () => {
    const getFile = vi.fn(async () => record);
    const openAttachment = vi.fn(async () => ({ body: 'first draft', contentType: 'text/plain' }));
    const app = new Hono();
    mountFileContent(app, async () => ({ getFile, openAttachment }));
    const response = await app.request('/api/files/file-a/versions/version-old/content');
    expect(response.status).toBe(200);
    expect(getFile).toHaveBeenCalledWith('file-a', 'version-old');
    expect(openAttachment).toHaveBeenCalledWith('old-attachment');
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
