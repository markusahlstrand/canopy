import type { Context, Env, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { knownLengthStream, type AttachmentOpenOptions, type OpenedAttachmentStream } from '@substrat-run/kernel';
import { parseByteRange } from '@substrat-run/vertical-host';

export interface FileContentRecord {
  file: { name: string };
  version: { source: string; blob_ref: string | null; mime: string } | null;
}

/** What the route reads from an opened attachment: the kernel's `openStream` answer, narrowed. */
export type OpenedContent = Pick<OpenedAttachmentStream, 'body' | 'contentType' | 'range'> & {
  record: Pick<OpenedAttachmentStream['record'], 'sha256' | 'size'>;
};

interface ContentSession {
  getFile: (fileId: string, versionId?: string) => Promise<FileContentRecord>;
  openAttachment: (id: string, options?: AttachmentOpenOptions) => Promise<OpenedContent | null>;
}

const ACTIVE_TYPES = ['text/html', 'image/svg+xml', 'application/xhtml+xml'];

/** Let the store's object go now rather than when the unread stream is collected. */
const release = (opened: OpenedContent) => opened.body.stream.getReader().cancel().catch(() => {});

/**
 * Both current and historical bytes use the same identity and attachment gate.
 *
 * The bytes stream from the store and are never held whole, and a single `Range` is read from the
 * store as a slice (Substrat 0.197, `openStream(id, { range })`), so a seek in a long video costs
 * the bytes it asks for. Substrat's `serveAttachment` does the same, but always answers
 * `attachment` with a sandbox CSP, which would stop the PDF preview's `<object>` rendering; the
 * drive keeps its own disposition rule and names the file by its drive name.
 */
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
    const blobRef = version.blob_ref;

    // Only a GET is answered in part, and a malformed or multi-range header is ignored (RFC 9110
    // §14.2), so the whole file is served. The ETag is the content's SHA-256, which never changes
    // under an attachment id, so an `If-Range` other than it asks for the whole file.
    const head = c.req.method === 'HEAD';
    const ifRange = c.req.header('If-Range')?.trim();
    let range = head ? undefined : parseByteRange(c.req.header('Range'));
    if (range && ifRange !== undefined && !/^"[0-9a-f]{64}"$/.test(ifRange)) range = undefined;
    let opened = await session.openAttachment(blobRef, range ? { range } : undefined);
    if (opened && range && ifRange !== undefined && ifRange !== `"${opened.record.sha256}"`) {
      await release(opened);
      opened = await session.openAttachment(blobRef);
    }
    if (!opened) throw new HTTPException(404, { message: 'the bytes this version names are gone' });

    const contentType = opened.contentType || version.mime;
    const activeType = ACTIVE_TYPES.includes(contentType.split(';')[0]!.trim().toLowerCase());
    const headers = new Headers({
      'content-type': contentType,
      'content-disposition': `${activeType ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      etag: `"${opened.record.sha256}"`,
    });
    if (activeType) headers.set('content-security-policy', "sandbox; default-src 'none'");

    if (opened.range === 'unsatisfiable') {
      await release(opened);
      headers.set('content-range', `bytes */${opened.record.size}`);
      headers.set('content-length', '0');
      return new Response(null, { status: 416, headers });
    }
    // No `range` on the answer means none was asked, or the store could not slice and sent it all.
    const status = opened.range ? 206 : 200;
    if (opened.range) headers.set('content-range', `bytes ${opened.range.start}-${opened.range.end}/${opened.record.size}`);
    headers.set('content-length', String(opened.body.length));
    if (head) {
      await release(opened);
      return new Response(null, { status, headers });
    }
    return new Response(knownLengthStream(opened.body) as ReadableStream<Uint8Array>, { status, headers });
  };
  app.on(['GET', 'HEAD'], '/api/files/:fileId/content', serve);
  app.on(['GET', 'HEAD'], '/api/files/:fileId/versions/:versionId/content', serve);
}
