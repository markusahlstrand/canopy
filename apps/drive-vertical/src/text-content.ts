import type { Context, Env, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

export const MAX_EDIT_CHARS = 200_000;
const MAX_EDIT_BYTES = MAX_EDIT_CHARS * 4;
export function editableTextMime(mime: string): boolean {
  const type = mime.split(';')[0]!.trim().toLowerCase();
  return type.startsWith('text/') || type === 'application/json' || type === 'application/xml';
}
export interface TextContentRecord {
  file: { id: string; name: string };
  version: { id: string; source: string; mime: string } | null;
  canWrite?: boolean;
}
interface TextSession {
  getFile: (id: string) => Promise<TextContentRecord>;
  upload: (id: string, name: string, mime: string, body: Uint8Array) => Promise<string>;
  record: (id: string, attachment: string, expected: string) => Promise<{ id: string; current_version_id: string | null }>;
  afterWrite: (file: { id: string; name: string; versionId: string; mime: string }, bytes: Uint8Array) => Promise<void>;
}

/** Save by file identity, with an atomic version comparison inside the scope. */
export function mountTextContent<E extends Env>(app: Hono<E>, resolve: (c: Context<E>) => Promise<TextSession | null>) {
  app.put('/api/files/:fileId/content', async (c) => {
    const session = await resolve(c);
    if (!session) throw new HTTPException(401, { message: 'unauthorized' });
    const id = c.req.param('fileId');
    const { file, version, canWrite } = await session.getFile(id);
    if (!canWrite) throw new HTTPException(403, { message: 'this file is read-only' });
    if (!version) throw new HTTPException(404, { message: 'this file has no content yet' });
    if (version.source !== 'blob') throw new HTTPException(501, { message: 'connected content cannot be edited here' });
    if (!editableTextMime(version.mime)) throw new HTTPException(415, { message: 'only text content can be edited here' });
    const expected = c.req.query('expectedVersion');
    if (!expected || expected.length > 100) throw new HTTPException(400, { message: 'expectedVersion is required' });
    if (expected !== version.id) throw new HTTPException(409, { message: 'file changed — reload before saving' });
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = c.req.raw.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > MAX_EDIT_BYTES) {
            await reader.cancel();
            throw new HTTPException(413, { message: 'text is too large to edit here' });
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
    catch { throw new HTTPException(400, { message: 'text must be UTF-8' }); }
    if (text.length > MAX_EDIT_CHARS) throw new HTTPException(413, { message: 'text is too large to edit here' });
    const attachment = await session.upload(id, file.name, version.mime, bytes);
    // The initial comparison saves work; this one guards concurrent writes during upload.
    const written = await session.record(id, attachment, expected);
    if (written.current_version_id) {
      await session.afterWrite({ id, name: file.name, mime: version.mime, versionId: written.current_version_id }, bytes)
        .catch((error: unknown) => console.error('drive.text-index.failed', { fileId: id, error: String(error) }));
    }
    return c.json(written, 201);
  });
}
