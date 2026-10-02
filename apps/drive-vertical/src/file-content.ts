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
    // Substrat 0.134 opens and verifies the complete attachment. Its open() has no
    // range option, so slice those verified bytes rather than bypassing the read gate.
    const bytes = opened.body instanceof Uint8Array ? opened.body : new Uint8Array(await new Response(opened.body).arrayBuffer());
    const contentType = opened.contentType || version.mime;
    const activeType = ['text/html', 'image/svg+xml', 'application/xhtml+xml'].includes(contentType.split(';')[0]!.trim().toLowerCase());
    const headers = new Headers({
      'content-type': contentType,
      'content-disposition': `${activeType ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      'content-length': String(bytes.byteLength),
    });
    if (activeType) headers.set('content-security-policy', "sandbox; default-src 'none'");
    const range = c.req.method === 'HEAD' || c.req.header('If-Range') ? undefined : c.req.header('Range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      const size = bytes.byteLength;
      let start = 0;
      let end = size - 1;
      let valid = !!match && !!(match[1] || match[2]) && size > 0;
      if (valid && match) {
        if (!match[1]) {
          const suffix = Number(match[2]);
          valid = Number.isSafeInteger(suffix) && suffix > 0;
          start = Math.max(0, size - suffix);
        } else {
          start = Number(match[1]);
          const requestedEnd = match[2] ? Number(match[2]) : end;
          valid = Number.isSafeInteger(start) && Number.isSafeInteger(requestedEnd) && start < size && requestedEnd >= start;
          end = Math.min(requestedEnd, end);
        }
      }
      if (!valid) {
        headers.set('content-range', `bytes */${size}`);
        headers.set('content-length', '0');
        return new Response(null, { status: 416, headers });
      }
      headers.set('content-range', `bytes ${start}-${end}/${size}`);
      headers.set('content-length', String(end - start + 1));
      return new Response(bytes.slice(start, end + 1), { status: 206, headers });
    }
    return new Response(c.req.method === 'HEAD' ? null : opened.body, { headers });
  };
  app.on(['GET', 'HEAD'], '/api/files/:fileId/content', serve);
  app.on(['GET', 'HEAD'], '/api/files/:fileId/versions/:versionId/content', serve);
}
