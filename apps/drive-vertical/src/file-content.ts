import type { Context, Env, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

export interface FileContentRecord {
  file: { name: string };
  version: { source: string; blob_ref: string | null; mime: string } | null;
}

interface ContentSession {
  getFile: (fileId: string, versionId?: string) => Promise<FileContentRecord>;
  openAttachment: (id: string) => Promise<{ body: BodyInit; contentType: string } | null>;
}

/** Both current and historical bytes use the same identity and attachment gate. */
export function mountFileContent<E extends Env>(
  app: Hono<E>,
  resolve: (c: Context<E>) => Promise<ContentSession | null>,
) {
  const serve = async (c: Context<E>) => {
    const session = await resolve(c);
    if (!session) throw new HTTPException(401, { message: 'unauthorized' });
    const { file, version } = await session.getFile(c.req.param('fileId')!, c.req.param('versionId'));
    if (!version) throw new HTTPException(404, { message: 'this file has no content yet' });
    if (version.source !== 'blob' || !version.blob_ref) {
      throw new HTTPException(501, { message: 'this version lives in a connected source, and connector reads are not wired yet' });
    }
    const opened = await session.openAttachment(version.blob_ref);
    if (!opened) throw new HTTPException(404, { message: 'the bytes this version names are gone' });
    return new Response(opened.body, { headers: {
      'content-type': opened.contentType || version.mime,
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    } });
  };
  app.get('/api/files/:fileId/content', serve);
  app.get('/api/files/:fileId/versions/:versionId/content', serve);
}
