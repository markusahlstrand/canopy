import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { mountTextContent, editableTextMime, MAX_EDIT_CHARS, type TextContentRecord } from './text-content';
const record: TextContentRecord = { file: { id: 'a', name: 'notes.md' }, version: { id: 'v1', source: 'blob', mime: 'text/markdown' }, canWrite: true };
function setup(value = record) {
  const upload = vi.fn(async () => 'attachment');
  const commit = vi.fn(async () => ({ id: 'a', current_version_id: 'v2' }));
  const afterWrite = vi.fn(async () => {});
  const app = new Hono();
  mountTextContent(app, async () => ({ getFile: async () => value, upload, record: commit, afterWrite }));
  const save = (body: string | Uint8Array = 'new text', query = '?expectedVersion=v1') => app.request('/api/files/a/content' + query, { method: 'PUT', body, headers: { 'content-type': 'image/png' } });
  return { save, upload, commit, afterWrite };
}
describe('conditional text content route', () => {
  it('saves by identity with the recorded MIME and expected version', async () => {
    const s = setup();
    expect((await s.save()).status).toBe(201);
    expect(s.upload).toHaveBeenCalledWith('a', 'notes.md', 'text/markdown', new TextEncoder().encode('new text'));
    expect(s.commit).toHaveBeenCalledWith('a', 'attachment', 'v1');
    expect(s.afterWrite).toHaveBeenCalledWith({ id: 'a', name: 'notes.md', mime: 'text/markdown', versionId: 'v2' }, new TextEncoder().encode('new text'));
  });
  it('permits an empty file', async () => { expect((await setup().save('')).status).toBe(201); });
  it.each([
    [{ ...record, canWrite: false }, 403],
    [{ ...record, version: null }, 404],
    [{ ...record, version: { id: 'v1', source: 'external', mime: 'text/plain' } }, 501],
    [{ ...record, version: { id: 'v1', source: 'blob', mime: 'image/png' } }, 415],
  ] as const)('refuses unsupported content before upload', async (value, status) => {
    const s = setup(value); expect((await s.save()).status).toBe(status); expect(s.upload).not.toHaveBeenCalled();
  });
  it('requires a current version and refuses stale requests before upload', async () => {
    const s = setup(); expect((await s.save('', '')).status).toBe(400);
    expect((await s.save('', '?expectedVersion=old')).status).toBe(409); expect(s.upload).not.toHaveBeenCalled();
  });
  it('does not index a write that loses the comparison during upload', async () => {
    const s = setup(); s.commit.mockRejectedValue(new HTTPException(409));
    expect((await s.save()).status).toBe(409); expect(s.afterWrite).not.toHaveBeenCalled();
  });
  it('bounds actual bytes and decoded characters, and requires valid UTF-8', async () => {
    const s = setup();
    expect((await s.save('a'.repeat(MAX_EDIT_CHARS + 1))).status).toBe(413);
    expect((await s.save(new Uint8Array(MAX_EDIT_CHARS * 4 + 1))).status).toBe(413);
    expect((await s.save(new Uint8Array([255]))).status).toBe(400);
    expect(s.upload).not.toHaveBeenCalled();
  });
  it('requires authentication', async () => {
    const app = new Hono(); mountTextContent(app, async () => null);
    expect((await app.request('/api/files/a/content', { method: 'PUT' })).status).toBe(401);
  });
  it('normalizes MIME parameters for text detection', () => {
    expect(editableTextMime('Application/JSON; charset=utf-8')).toBe(true);
    expect(editableTextMime('image/svg+xml')).toBe(false);
  });
});
