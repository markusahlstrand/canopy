import { HTTPException } from 'hono/http-exception';

/**
 * The largest upload this vertical accepts, and why there is a number at all.
 *
 * The attachment surface takes bytes, not a stream — it hashes them and records the
 * length — so an upload is materialized in the isolate before it is stored. A Worker
 * isolate has 128 MB of memory for everything it is doing, and Cloudflare will hand a
 * worker a request body far larger than that (100 MB on the lower plans, more above),
 * so an unbounded read is an out-of-memory waiting for the first person who drags a
 * video in. 25 MB is a document store's honest ceiling; raising it is a decision about
 * isolate memory, not a config tweak.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Read the body, refusing anything past the cap — WITHOUT trusting `content-length`.
 *
 * The header is checked first because it turns the common case into a refusal that
 * costs nothing. It is not sufficient: it can be absent on a chunked upload and it can
 * lie, and a cap that a lying header defeats is not a cap. So the read is bounded too,
 * and stops the moment the accumulated length passes the limit rather than after.
 */
export async function readBounded(req: Request, limit = MAX_UPLOAD_BYTES, refusal = `upload exceeds ${limit} bytes`): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) {
    throw new HTTPException(413, { message: refusal });
  }
  if (!req.body) return new Uint8Array();

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new HTTPException(413, { message: refusal });
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}
