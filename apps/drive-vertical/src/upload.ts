/**
 * Putting a file's bytes into a folder: the app's upload route, the assistant's `drive_upload-file`
 * and a redeemed upload link all go through `uploadToFolder`, so they make the same checks in the
 * same order and cannot drift apart.
 *
 *  1. `drive/ensure-file`: `drive:write` on the folder, then create-or-return by name. A source that
 *     takes no uploads (Qonto) refuses a new file here.
 *  2. The bytes, through the attachment surface (never through `invoke`), against that file.
 *  3. `drive/record-version`, which also queues the version's `arrived` for flows, in the same
 *     transaction as the version.
 *  4. In an a3doc space, `drive/send-source-file` with the other categories (`alsoIn`).
 *  5. Then the space's indexing and automation run, after the response where the runtime allows.
 *
 * What the assistant's two doors add in front is `uploadPreflight` (the folder, the source, the
 * categories, checked before anything is written) and `checkedUpload` (a type the space takes,
 * from the name, matching the bytes).
 */
import type { Context, Env, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { errorCodeOf } from '@substrat-run/contracts';
import { MAX_UPLOAD_BYTES, readBounded } from './upload-limit.js';

/** What one upload needs in one space, as the caller there. */
export interface UploadTarget {
  /** The caller's stub in the space. */
  scope: { invoke<T = unknown>(operation: string, input?: unknown): Promise<T> };
  /** Store bytes against a file through the attachment surface; the attachment id. */
  store(fileId: string, name: string, mime: string, body: Uint8Array): Promise<string>;
  /** Index the write and start the space's automation (it is already queued). */
  afterWrite(): Promise<void>;
}

/** A file row as the drive returns it. */
export interface UploadedFile { id: string; folder_id: string; name: string; current_version_id: string | null; [key: string]: unknown }

export interface UploadOutcome {
  /** A new file, rather than one that was there already under that name. */
  created: boolean;
  /** Bytes were written: a new file, or a new version of one. */
  wrote: boolean;
  file: UploadedFile;
  /** Where a connected space sends it. `error`: the send was refused; the file is uploaded here all the same. */
  source: null | { provider: string; sent: boolean; alsoIn: string[]; error?: unknown };
}

/**
 * Put bytes into a folder. `existing` says what a live file already holding the name means:
 * `version` writes a new version of it (the app's drag-and-drop), `refuse` is a 409 (the app's
 * "New → …"), `keep` returns it untouched (the assistant: an a3doc copy can't be deleted, so a
 * retried call must not file it twice). A row holding the name with no version yet is an upload
 * that failed halfway, and is completed in every mode.
 */
export async function uploadToFolder(
  target: UploadTarget,
  input: {
    folderId: string;
    name: string;
    mime: string;
    /** Read only once the caller may write here, so a refusal never buffers a large body. */
    body: () => Promise<Uint8Array>;
    alsoIn?: string[];
    existing: 'version' | 'refuse' | 'keep';
  },
): Promise<UploadOutcome> {
  const file = await target.scope.invoke<UploadedFile>('drive/ensure-file', { folderId: input.folderId, name: input.name });
  if (file.current_version_id) {
    if (input.existing === 'refuse') throw new HTTPException(409, { message: `This folder already has a file named '${input.name}'.` });
    if (input.existing === 'keep') return { created: false, wrote: false, file, source: null };
  }
  const created = !file.current_version_id;
  const body = await input.body();
  const blobRef = await target.store(file.id, input.name, input.mime, body);
  // No mime or size passed: `record-version` reads both off the attachment row. Where a second
  // version is never wanted (`keep`, `refuse`), the first is written only if the file still has none:
  // two uploads racing to a new name both see it empty, and only one may become its version.
  const firstOnly = created && input.existing !== 'version';
  let written: UploadedFile;
  try {
    written = await target.scope.invoke<UploadedFile>('drive/record-version', {
      fileId: file.id, ...(firstOnly ? { expectedCurrentVersion: null } : {}), location: { source: 'blob', blobRef },
    });
  } catch (error) {
    if (!firstOnly || errorCodeOf(error) !== 'conflict') throw error;
    // The other upload won. Its file is the answer; these bytes stay an attachment no version names.
    const winner = await target.scope.invoke<UploadedFile>('drive/ensure-file', { folderId: input.folderId, name: input.name });
    if (!winner.current_version_id) throw error;
    if (input.existing === 'refuse') throw new HTTPException(409, { message: `This folder already has a file named '${input.name}'.` });
    return { created: false, wrote: false, file: winner, source: null };
  }

  // In a connected space an upload goes on to a3doc; its echo adopts this row (#358).
  let source: UploadOutcome['source'] = null;
  const connected = (await target.scope.invoke<{ source: { provider: string } | null }>('drive/get-source')).source;
  if (connected) {
    const alsoIn = input.alsoIn ?? [];
    try {
      const sent = await target.scope.invoke<{ alsoIn?: string[] }>('drive/send-source-file', { fileId: file.id, ...(alsoIn.length ? { alsoIn } : {}) });
      source = { provider: connected.provider, sent: true, alsoIn: sent.alsoIn ?? [] };
    } catch (error) {
      source = { provider: connected.provider, sent: false, alsoIn: [], error };
    }
  }
  // The write queued itself for automation (Document AI, flows); the dispatcher takes it now.
  if (written.current_version_id) await target.afterWrite();
  return { created, wrote: true, file: written, source };
}

/** The most an assistant may send inline, as base64 in a tool call. */
export const MAX_INLINE_UPLOAD_BYTES = 5 * 1024 * 1024;
/** How long an upload link lasts. */
export const UPLOAD_LINK_TTL_MS = 10 * 60 * 1000;
/** At most this many more categories (folders) a document is filed in. */
export const MAX_ALSO_IN = 10;

type Sniff = (bytes: Uint8Array) => boolean;

/**
 * A ZIP's entries, read from the archive's own structure: the end-of-central-directory record, each
 * central directory header, and the local file header it points at (whose name is the one read).
 * Null for anything that is not a well-formed ZIP. Data is kept for stored (uncompressed) entries.
 */
function zipEntries(b: Uint8Array): { name: string; stored: Uint8Array | null }[] | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const sig = (at: number, value: number) => at >= 0 && at + 4 <= b.byteLength && u32(at) === value;
  let end = -1;
  for (let at = b.byteLength - 22; at >= Math.max(0, b.byteLength - 22 - 0xffff); at--) {
    if (sig(at, 0x06054b50)) { end = at; break; }
  }
  if (end < 0) return null;
  const count = u16(end + 10), size = u32(end + 12), offset = u32(end + 16);
  if (count > 10_000 || offset + size > end) return null;
  const names = new TextDecoder();
  const entries: { name: string; stored: Uint8Array | null }[] = [];
  for (let at = offset, i = 0; i < count; i++) {
    if (!sig(at, 0x02014b50) || at + 46 > end) return null;
    const method = u16(at + 10), compressed = u32(at + 20), local = u32(at + 42);
    if (!sig(local, 0x04034b50) || local + 30 > b.byteLength) return null;
    const nameLength = u16(local + 26), extra = u16(local + 28);
    const data = local + 30 + nameLength + extra;
    if (data + compressed > b.byteLength) return null;
    entries.push({
      name: names.decode(b.subarray(local + 30, local + 30 + nameLength)),
      stored: method === 0 ? b.subarray(data, data + compressed) : null,
    });
    at += 46 + u16(at + 28) + u16(at + 30) + u16(at + 32);
  }
  return entries;
}
/** An Office Open XML package: a ZIP holding `[Content_Types].xml`. */
const ooxml: Sniff = (b) => !!zipEntries(b)?.some((e) => e.name === '[Content_Types].xml');
/** An OpenDocument package: a ZIP whose stored `mimetype` entry names this very type. */
const odf = (mime: string): Sniff => (b) =>
  !!zipEntries(b)?.some((e) => e.name === 'mimetype' && e.stored !== null && new TextDecoder().decode(e.stored) === mime);

const startsWith = (bytes: Uint8Array, ...sig: number[]) => sig.every((b, i) => bytes[i] === b);
const ascii = (bytes: Uint8Array, at: number, text: string) => [...text].every((ch, i) => bytes[at + i] === ch.charCodeAt(0));
const ole: Sniff = (b) => startsWith(b, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
/** UTF-8 text with no NUL: a text type whose bytes are not text is something else named as text. */
const text: Sniff = (b) => {
  if (b.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(b);
    return true;
  } catch {
    return false;
  }
};
const pdf: Sniff = (b) => {
  // The header may sit after some leading bytes; readers look within the first 1 KB.
  const head = b.subarray(0, 1024);
  for (let i = 0; i + 5 <= head.length; i++) if (ascii(head, i, '%PDF-')) return true;
  return false;
};
const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];

/**
 * The types an upload may be, by extension: documents, images and office files. Active content (HTML,
 * SVG, scripts, executables) and archives are not here, so they are refused. The type stored is the
 * one named here, never the one a caller declares, and the bytes must look like it.
 */
export const UPLOAD_TYPES: Record<string, { mime: string; sniff: Sniff }> = {
  pdf: { mime: 'application/pdf', sniff: pdf },
  png: { mime: 'image/png', sniff: (b) => startsWith(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) },
  jpg: { mime: 'image/jpeg', sniff: (b) => startsWith(b, 0xff, 0xd8, 0xff) },
  jpeg: { mime: 'image/jpeg', sniff: (b) => startsWith(b, 0xff, 0xd8, 0xff) },
  gif: { mime: 'image/gif', sniff: (b) => ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a') },
  webp: { mime: 'image/webp', sniff: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP') },
  heic: { mime: 'image/heic', sniff: (b) => ascii(b, 4, 'ftyp') && HEIF_BRANDS.some((brand) => ascii(b, 8, brand)) },
  tif: { mime: 'image/tiff', sniff: (b) => startsWith(b, 0x49, 0x49, 0x2a, 0x00) || startsWith(b, 0x4d, 0x4d, 0x00, 0x2a) },
  tiff: { mime: 'image/tiff', sniff: (b) => startsWith(b, 0x49, 0x49, 0x2a, 0x00) || startsWith(b, 0x4d, 0x4d, 0x00, 0x2a) },
  txt: { mime: 'text/plain', sniff: text },
  md: { mime: 'text/markdown', sniff: text },
  csv: { mime: 'text/csv', sniff: text },
  json: { mime: 'application/json', sniff: text },
  xml: { mime: 'application/xml', sniff: text },
  /** A signed Facturae e-invoice. */
  xsig: { mime: 'application/xml', sniff: text },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sniff: ooxml },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sniff: ooxml },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', sniff: ooxml },
  odt: { mime: 'application/vnd.oasis.opendocument.text', sniff: odf('application/vnd.oasis.opendocument.text') },
  ods: { mime: 'application/vnd.oasis.opendocument.spreadsheet', sniff: odf('application/vnd.oasis.opendocument.spreadsheet') },
  doc: { mime: 'application/msword', sniff: ole },
  xls: { mime: 'application/vnd.ms-excel', sniff: ole },
};

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};
/** The accepted type an extension names: own entries only, so `.constructor` or `.__proto__` names none. */
const typeFor = (name: string) => {
  const extension = extensionOf(name);
  return Object.hasOwn(UPLOAD_TYPES, extension) ? UPLOAD_TYPES[extension] : undefined;
};

/** The type a file of this name is stored as, or a refusal naming what is accepted. */
export function uploadTypeOf(name: string): string {
  const type = typeFor(name);
  if (!type) {
    throw new HTTPException(415, { message: `Files named '.${extensionOf(name) || '(none)'}' can't be uploaded here. Accepted: ${Object.keys(UPLOAD_TYPES).join(', ')}.` });
  }
  return type.mime;
}

/** The checked type of these bytes under this name: an accepted extension, not empty, and bytes that look like it. */
export function checkedUpload(name: string, bytes: Uint8Array): string {
  const mime = uploadTypeOf(name);
  if (bytes.byteLength === 0) throw new HTTPException(400, { message: 'The file is empty.' });
  if (!typeFor(name)!.sniff(bytes)) {
    throw new HTTPException(415, { message: `The bytes are not a .${extensionOf(name)} file: check the name or the content.` });
  }
  return mime;
}

/** Strict base64 to bytes, refusing more than `limit` decoded bytes before decoding them. */
export function decodeBase64(value: string, limit = MAX_INLINE_UPLOAD_BYTES): Uint8Array {
  const clean = value.replace(/\s+/g, '');
  if (Math.floor((clean.length * 3) / 4) - (clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0) > limit) {
    throw new HTTPException(413, { message: `Inline uploads are at most ${limit / 1024 / 1024} MB; use drive_create-upload-link for larger files.` });
  }
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    throw new HTTPException(400, { message: 'contentBase64 is not valid base64.' });
  }
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Before anything is written: the folder exists and the caller may add files to it, the space takes
 * uploads (a Qonto mirror does not), and every `alsoIn` category is an a3doc folder they may write.
 */
export async function uploadPreflight(scope: UploadTarget['scope'], input: { folderId: string; alsoIn?: string[] }): Promise<void> {
  const writable = async (folderId: string, what: string) => {
    const folder = await scope.invoke<{ id: string; canWrite?: boolean } | null>('drive/get-folder', { folderId }).catch(() => null);
    if (!folder) throw new HTTPException(404, { message: `There is no ${what} '${folderId}' in this space. drive_list-space-folders lists them.` });
    if (!folder.canWrite) throw new HTTPException(403, { message: `You can't add files to the ${what} '${folderId}': only someone who may write there (an owner or editor) can upload.` });
  };
  await writable(input.folderId, 'folder');
  const { source } = await scope.invoke<{ source: { provider: string; canUpload: boolean } | null }>('drive/get-source');
  if (source && !source.canUpload) {
    throw new HTTPException(403, { message: source.provider === 'canopy.qonto'
      ? 'This space mirrors a Qonto account and takes no uploads. Upload to an a3doc or storage space instead; a flow can file it from there.'
      : "This space mirrors a source that takes no uploads from you." });
  }
  const alsoIn = input.alsoIn ?? [];
  if (!alsoIn.length) return;
  if (source?.provider !== 'canopy.a3doc') throw new HTTPException(400, { message: 'alsoIn files a document in more a3doc categories, so it is only for a3doc spaces.' });
  if (alsoIn.length > MAX_ALSO_IN) throw new HTTPException(400, { message: `A file can be filed in at most ${MAX_ALSO_IN} other folders.` });
  for (const id of alsoIn) await writable(id, 'category folder');
}

/** A stored upload link, as redeeming it needs it. */
export interface UploadLink { sub: string; scopeId: string; folderId: string; name: string; alsoIn: string[]; expiresAt: number }

/** A fresh link token: 256 random bits, base64url, prefixed so a leaked one is recognizable. */
export function mintUploadToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `canopy_up_${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/** What a link is stored and looked up by: its token's SHA-256, never the token. */
export async function uploadTokenHash(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What redeeming a link needs from the install. */
export interface UploadLinkAccess {
  /** The link, if it is still usable now: not expired, not used. */
  peek(tokenHash: string, now: number): Promise<UploadLink | null>;
  /** Mark it used, once: false when another request got there first (or it expired meanwhile). */
  claim(tokenHash: string, now: number): Promise<boolean>;
  /** The link's login in its space, as its principal there NOW, or null when it is no longer a member. */
  targetFor(sub: string, scopeId: string): Promise<UploadTarget | null>;
  now(): number;
}

/**
 * `PUT /api/upload-links/:token`: the raw bytes of the one file a link was minted for. The token is
 * the credential and the link names everything else (space, folder, name, categories), so the body
 * is all a caller sends. A cross-site browser cannot send it: a cross-origin PUT needs a CORS
 * preflight, and nothing here answers one.
 *
 * Checked again at redemption, because ten minutes is long enough for things to change: the login
 * must still be a member of the space and may still write the folder. The link is spent once the
 * body is read and its type checked, so a failure after that needs a new link.
 */
export function mountUploadLinks<E extends Env>(app: Hono<E>, resolve: (c: Context<E>) => Promise<UploadLinkAccess>) {
  app.put('/api/upload-links/:token', async (c) => {
    const access = await resolve(c);
    const hash = await uploadTokenHash(c.req.param('token'));
    const unusable = () => new HTTPException(410, { message: 'This upload link has expired or was already used. Ask for a new one with drive_create-upload-link.' });
    const link = await access.peek(hash, access.now());
    if (!link) throw unusable();
    const mime = uploadTypeOf(link.name);
    const declared = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (declared && declared !== 'application/octet-stream' && declared !== mime) {
      throw new HTTPException(415, { message: `This link takes a ${mime} file ('${link.name}'), not ${declared}.` });
    }
    const target = await access.targetFor(link.sub, link.scopeId);
    if (!target) throw new HTTPException(403, { message: 'You are no longer a member of the space this link uploads to.' });
    await uploadPreflight(target.scope, { folderId: link.folderId, alsoIn: link.alsoIn });
    const body = await readBounded(c.req.raw, MAX_UPLOAD_BYTES, `An upload is at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
    checkedUpload(link.name, body);
    if (!(await access.claim(hash, access.now()))) throw unusable();
    const outcome = await uploadToFolder(target, { folderId: link.folderId, name: link.name, mime, body: async () => body, alsoIn: link.alsoIn, existing: 'keep' });
    return c.json(uploadResult(outcome), outcome.created ? 201 : 200);
  });
}

/** An outcome as a caller reads it: what was filed where, and whether a connected source got it. */
export function uploadResult(outcome: UploadOutcome) {
  const { file, source } = outcome;
  return {
    created: outcome.created,
    file: { id: file.id, name: file.name, folderId: file.folder_id, currentVersionId: file.current_version_id },
    source: source && {
      provider: source.provider,
      sent: source.sent,
      alsoIn: source.alsoIn,
      ...(source.error === undefined ? {} : { pending: source.error instanceof Error ? source.error.message : String(source.error) }),
    },
  };
}
