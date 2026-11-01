/**
 * An S3 bucket prefix as a Substrat file source: reads are a sync that lands `fileSourceChange`
 * through the binding's operation, writes are two events the vertical emits. Design: canopy
 * `documentation/planning/connected-spaces-file-sources.md`; this is the second file source after a3doc.
 *
 * - **The binding** names a prefix (`folder`, `''` = the whole bucket). Paths the vertical sees are
 *   relative to it.
 * - **Item ids are object keys**: a file is its key, a folder its key with a trailing `/`. A key is
 *   deterministic, so a sweep that fails after landing and runs again lands the same identity, never
 *   a second one. A move made through {@link S3_ITEMS_EVENT} keeps the item's id: the new keys are
 *   recorded in a durable moves journal before the copy, and the sync reads it for a key it does
 *   not hold yet.
 * - **Folders** are key prefixes. One is landed before the first file under it, and for every
 *   zero-byte `name/` marker object (which is also how {@link S3_ITEMS_EVENT} `mkdir` makes one).
 * - **Reads.** S3 has no change feed: each pass lists the prefix in key order, `startAfter` the last
 *   key it finished, and compares each object's ETag with the one held. A pass is cut into calls by
 *   a download budget, so a call stays under the platform's outbound ceiling.
 * - **Deletes land only on an answer about that item.** A held item the pass never presented is
 *   checked on its own: `HEAD` for a file, a one-key listing for a folder. Never a listing's silence.
 * - **Writes.** `s3.files-requested` is the shared `fileSourceWriteRequest`, and all three conflict
 *   modes hold: `replace` is a plain PUT, `fail` and `rename` are create-only PUTs (`If-None-Match: *`).
 *   Each object written carries `x-amz-meta-canopy-write: <event>:<attachment>`, so a retry whose
 *   answer was lost recognises its own object instead of failing or renaming again.
 *   `s3.items-requested` deletes, moves (rename is a move) and makes folders: the shared contract has
 *   no words for those yet, so this package names them in {@link s3ItemsRequest}.
 * - **No echo.** A file written from the vertical is recorded with the vertical's own attachment, so
 *   the sync adopts it by landing that attachment as its content instead of downloading the bytes
 *   it just wrote.
 */
import { z } from 'zod';
import {
  FILE_SOURCE_MAX_FILE_BYTES,
  fileSourceChange,
  fileSourceUpsertAnswer,
  fileSourceWriteRequest,
  type DomainEvent,
  type FileSourceChange,
} from '@substrat-run/contracts';
import { connectorUploadBody, ConnectorRefusal, type ScopedConnectionContext } from '@substrat-run/kernel';
import { S3Error, type S3Client, type S3Object } from './client.js';
import { clientFor, nowOf, s3Secret, type S3Options } from './connection.js';

// ── the public contract ──────────────────────────────────────────────────────

/** The event a vertical emits to put files in its bound prefix. Payload: `fileSourceWriteRequest`. */
export const S3_FILES_EVENT = 's3.files-requested';
/** The event a vertical emits to delete, move or create items. Payload: {@link s3ItemsPayload}. */
export const S3_ITEMS_EVENT = 's3.items-requested';

const relPath = z.string().trim().min(1).max(1024);
/** What a vertical asks of the bucket beyond adding files. Paths are relative to the bound prefix. */
export const s3ItemsRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('delete'), items: z.array(z.object({ path: relPath, kind: z.enum(['file', 'folder']) })).min(1).max(20) }),
  /** A rename is a move within one folder. */
  z.object({ op: z.literal('move'), kind: z.enum(['file', 'folder']), from: relPath, to: relPath }),
  z.object({ op: z.literal('mkdir'), path: relPath }),
]);
export type S3ItemsRequest = z.infer<typeof s3ItemsRequest>;
/** The payload {@link S3_ITEMS_EVENT} travels with: the request under one field, as an operation's output emits it. */
export const s3ItemsPayload = z.object({ request: s3ItemsRequest });

/** Keys one sync call lists. */
export const PAGE_SIZE = 100;
/** Objects one sync call downloads; the rest of the page waits for the next call. */
export const SYNC_DOWNLOADS_PER_CALL = 20;
/** Held items one call checks on their own after a pass did not present them. */
export const SYNC_VERIFY_PER_CALL = 20;
/** Objects a folder move may hold: each is a copy and a delete, inside one call's outbound ceiling. */
export const MAX_MOVE_OBJECTS = 40;
/** Objects one delivery of a folder delete removes; a bigger folder finishes over retries. */
export const DELETES_PER_CALL = 80;
/** Names `rename` tries before it gives up. */
const MAX_RENAME = 20;
/** The metadata header (after `x-amz-meta-`) that says which write made an object. */
export const WRITE_TAG = 'canopy-write';

// ── state ────────────────────────────────────────────────────────────────────

const BINDING = 's3:binding';
const ITEM = 's3:item:';
/** Durable (through the journal operation): new key → the item id it carries over. */
const MOVES = 's3:moves';

interface Binding {
  prefix: string;
  pass?: Pass;
  lastSync?: { syncedAt: string; changes: number; skipped: number };
}

interface Pass {
  id: string;
  startedAt: string;
  /** The last key this pass finished. */
  startAfter?: string;
  /** Set once the listing is done: held keys the pass did not present, still to be checked. */
  verify?: string[];
  changes: number;
  /** Keys whose path the vertical cannot hold (an empty, `.` or `..` segment). */
  skipped: number;
}

type AttachmentPick = { id: string; filename: string; contentType: string; size: number; sha256: string };

interface ItemEntry {
  kind: 'file' | 'folder';
  itemId: string;
  /** Relative to the prefix; a folder's without the trailing `/`. */
  path: string;
  name: string;
  etag?: string;
  size?: number;
  /** The attachment the current content landed as. */
  attachmentId: string | null;
  tooLarge?: boolean;
  seenIn?: string;
  /** Written by the vertical and not landed yet: its own attachment, which is landed as the content. */
  echo?: AttachmentPick;
  /** Moved through a write and not landed at its new path yet. */
  previousPath?: string;
}

type Moves = Record<string, { itemId: string; at: string }>;

/** Platform-fenced state plus the durable journal, for both the sweep and the dispatch. */
interface Io {
  ctx: ScopedConnectionContext;
  client: S3Client;
  prefix: string;
  journalOperation: string;
  options: S3Options;
}

const itemKey = (key: string) => `${ITEM}${key}`;

async function readJournal<T>(io: Io, key: string): Promise<T | undefined> {
  const res = await io.ctx.invoke<{ value: unknown }>(io.journalOperation, { key });
  return (res?.value ?? undefined) as T | undefined;
}
const writeJournal = (io: Io, key: string, value: unknown) => io.ctx.invoke(io.journalOperation, { key, value });

async function readItems(io: Io): Promise<Map<string, ItemEntry>> {
  const items = new Map<string, ItemEntry>();
  for (const row of await io.ctx.state.list(ITEM)) {
    const key = row.key.slice(ITEM.length);
    if (key.startsWith(io.prefix) && row.value && typeof row.value === 'object') items.set(key, row.value as ItemEntry);
  }
  return items;
}

// ── naming ───────────────────────────────────────────────────────────────────

/** `''` → `''`, `/a/b/` → `a/b/`: a prefix always ends in `/` unless it is the whole bucket. */
export function normalizePrefix(folder: string): string {
  const clean = folder.split('/').map((s) => s.trim()).filter(Boolean).join('/');
  return clean ? `${clean}/` : '';
}

const validSegment = (s: string) => s.trim().length > 0 && s !== '.' && s !== '..' && !s.includes('\\');
const validPath = (path: string) => path.split('/').every(validSegment);
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** `Report.pdf` + `2` → `Report (2).pdf`. */
export function withSuffix(name: string, suffix: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${suffix})${name.slice(dot)}` : `${name} (${suffix})`;
}

function cleanRel(path: string, what: string): string {
  const clean = path.split('/').map((s) => s.trim()).filter(Boolean).join('/');
  if (!clean || !validPath(clean)) throw new ConnectorRefusal(`${what} '${path}' is not a valid path`);
  return clean;
}

// ── the binding ──────────────────────────────────────────────────────────────

/** Normalise a binding's options: the prefix, checked against the bucket once. */
export async function bindS3Context(ctx: ScopedConnectionContext, options: S3Options = {}): Promise<Record<string, unknown>> {
  const folder = typeof ctx.scope.options.folder === 'string' ? ctx.scope.options.folder : '';
  const prefix = normalizePrefix(folder);
  if (prefix && !validPath(prefix.slice(0, -1))) throw new ConnectorRefusal(`'${folder}' is not a valid folder`);
  // A prefix with nothing under it yet is fine (an empty space to fill); a key that cannot list is not.
  await clientFor(ctx.fetch, s3Secret.parse({ ...ctx.secret }), options).list({ prefix, maxKeys: 1 });
  // `canUpload`: the drive gates uploads on it (a3doc's role may forbid them). S3 has no such role
  // to read; a key without write access is refused per write instead.
  return { folder: prefix.replace(/\/$/, ''), prefix, canUpload: true };
}

function prefixOf(ctx: ScopedConnectionContext): string {
  const p = ctx.scope.options.prefix;
  if (typeof p !== 'string') throw new Error('s3 binding has no resolved prefix');
  return p;
}

// ── reads: the sync ──────────────────────────────────────────────────────────

export interface S3SyncResult {
  changes: number;
  /** False when the call stopped at a budget; the next call resumes where it stopped. */
  complete: boolean;
}

export async function syncS3Context(
  ctx: ScopedConnectionContext,
  config: { journalOperation: string } & S3Options & { pageSize?: number; maxDownloads?: number; maxVerify?: number },
): Promise<S3SyncResult> {
  const prefix = prefixOf(ctx);
  const io: Io = { ctx, client: clientFor(ctx.fetch, s3Secret.parse({ ...ctx.secret }), config), prefix, journalOperation: config.journalOperation, options: config };
  const stored = (await ctx.state.get(BINDING)) as Binding | undefined;
  // A binding to another prefix starts a fresh pass; items outside the prefix are simply not read.
  const binding: Binding = stored && stored.prefix === prefix ? stored : { prefix };
  const pass: Pass = binding.pass ?? { id: crypto.randomUUID(), startedAt: nowOf(config).toISOString(), changes: 0, skipped: 0 };
  const items = await readItems(io);
  // Bound to another prefix since: a held path is relative to the old one, so the item moves.
  for (const [key, e] of items) {
    const path = key.slice(prefix.length).replace(/\/$/, '');
    if (e.path !== path) items.set(key, { ...e, path, name: baseName(path), previousPath: e.previousPath ?? e.path });
  }
  /** The ids held when the call began: committed state, which a failed call cannot take back. */
  const committed = new Map([...items].map(([key, e]) => [key, e.itemId]));
  const moves = (await readJournal<Moves>(io, MOVES)) ?? {};
  /** What a key is called to the vertical: the id it already has, one a move carried over, or the key. */
  const idOf = (key: string) => items.get(key)?.itemId ?? moves[key]?.itemId ?? key;
  let changes = 0;

  const land = (change: FileSourceChange) => ctx.land(fileSourceChange.parse(change));
  const put = async (key: string, entry: ItemEntry | null) => {
    await ctx.state.put(itemKey(key), entry);
    if (entry) items.set(key, entry);
    else items.delete(key);
  };

  const ensureFolder = async (path: string): Promise<void> => {
    const key = `${prefix}${path}/`;
    const held = items.get(key);
    if (held?.seenIn === pass.id && !held.previousPath) return;
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (parent) await ensureFolder(parent);
    const entry: ItemEntry = { kind: 'folder', itemId: idOf(key), path, name: baseName(path), attachmentId: null, seenIn: pass.id };
    if (!held || held.previousPath) {
      await land({ change: 'upsert', connectionId: ctx.connection.id, itemId: entry.itemId, kind: 'folder', path, name: entry.name, previousPath: held?.previousPath ?? null, size: null, contentType: null, lastModifiedAt: null, webUrl: null, content: null });
      changes++;
    }
    const { previousPath: _landed, ...rest } = { ...held, ...entry };
    await put(key, rest);
  };

  let downloads = 0;
  const maxDownloads = config.maxDownloads ?? SYNC_DOWNLOADS_PER_CALL;
  /** Land one object; false (and nothing done) when its bytes would go over this call's budget. */
  const landFile = async (obj: S3Object, path: string): Promise<boolean> => {
    const held = items.get(obj.key);
    const tooLarge = obj.size > FILE_SOURCE_MAX_FILE_BYTES;
    const unchanged = !!held && !held.echo && held.etag === obj.etag && !!held.tooLarge === tooLarge && (!!held.attachmentId || tooLarge);
    if (unchanged && !held.previousPath) {
      if (held.seenIn !== pass.id) await put(obj.key, { ...held, seenIn: pass.id });
      return true;
    }
    if (unchanged) {
      // Moved through a write: the same content at its new path.
      await land({
        change: 'upsert', connectionId: ctx.connection.id, itemId: held.itemId, kind: 'file', path, name: baseName(path),
        previousPath: held.previousPath!, size: obj.size, contentType: contentTypeOf(path), lastModifiedAt: obj.lastModified, webUrl: null,
        content: tooLarge ? 'too-large' : 'unchanged',
      });
      changes++;
      const { previousPath: _landed, ...rest } = held;
      await put(obj.key, { ...rest, path, name: baseName(path), seenIn: pass.id });
      return true;
    }
    const echo = held?.echo && held.etag === obj.etag ? held.echo : undefined;
    const download = !tooLarge && !echo;
    if (download && downloads >= maxDownloads) return false;
    const name = baseName(path);
    const contentType = contentTypeOf(name);
    const entry: ItemEntry = {
      kind: 'file', itemId: idOf(obj.key), path, name, etag: obj.etag, size: obj.size,
      attachmentId: held?.attachmentId ?? null, tooLarge, seenIn: pass.id,
    };
    // The content that is current at the vertical: its own write when one is pending, else what landed last.
    const replaces = held?.echo?.id ?? held?.attachmentId ?? null;
    const answer = await land({
      change: 'upsert', connectionId: ctx.connection.id, itemId: entry.itemId, kind: 'file', path, name,
      previousPath: held?.previousPath ?? null, size: obj.size, contentType, lastModifiedAt: obj.lastModified, webUrl: null,
      content: tooLarge ? 'too-large' : 'follows',
    });
    changes++;
    const target = fileSourceUpsertAnswer.safeParse(answer);
    if (!tooLarge && target.success && target.data.entity) {
      let attachment: AttachmentPick | null = echo ?? null;
      if (!attachment) {
        downloads++;
        const bytes = await io.client.get(obj.key, obj.etag);
        // Gone or changed since the listing: the verify step, or the next pass, answers about it.
        if (bytes) {
          const record = await ctx.attachments.upload({
            entity: target.data.entity, filename: name, contentType: contentType ?? 'application/octet-stream', visibility: 'internal', body: connectorUploadBody(bytes),
          });
          attachment = { id: record.id, filename: record.filename, contentType: record.contentType, size: record.size, sha256: record.sha256 };
        }
      }
      if (attachment) {
        await land({ change: 'content', connectionId: ctx.connection.id, itemId: entry.itemId, kind: 'file', path, name, attachment, replaces });
        entry.attachmentId = attachment.id;
      }
    }
    await put(obj.key, entry);
    return true;
  };

  const save = async (patch: Partial<Binding>) => {
    Object.assign(binding, patch);
    await ctx.state.put(BINDING, binding);
  };

  // ── the listing ──
  if (!pass.verify) {
    const res = await io.client.list({ prefix, ...(pass.startAfter ? { startAfter: pass.startAfter } : {}), maxKeys: config.pageSize ?? PAGE_SIZE });
    for (const obj of res.objects) {
      const rel = obj.key.slice(prefix.length);
      const isFolder = rel.endsWith('/');
      const path = isFolder ? rel.slice(0, -1) : rel;
      if (!path) {
        pass.startAfter = obj.key;
        continue;
      }
      if (!validPath(path)) {
        pass.skipped++;
        pass.startAfter = obj.key;
        continue;
      }
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (isFolder) await ensureFolder(path);
      else {
        if (parent) await ensureFolder(parent);
        if (!(await landFile(obj, path))) {
          pass.changes += changes;
          await save({ pass });
          return { changes, complete: false };
        }
      }
      pass.startAfter = obj.key;
    }
    if (res.truncated) {
      pass.changes += changes;
      await save({ pass });
      return { changes, complete: false };
    }
    pass.verify = [...items.entries()].filter(([, e]) => e.seenIn !== pass.id).map(([key]) => key);
  }

  // ── held items the pass never presented: each checked on its own ──
  const queue = pass.verify;
  let checked = 0;
  while (queue.length && checked < (config.maxVerify ?? SYNC_VERIFY_PER_CALL)) {
    const key = queue.shift()!;
    const e = items.get(key);
    if (!e) continue;
    checked++;
    const present = e.kind === 'file' ? (await io.client.head(key)) !== null : (await io.client.list({ prefix: key, maxKeys: 1 })).objects.length > 0;
    if (present) continue;
    await land({ change: 'delete', connectionId: ctx.connection.id, itemId: e.itemId, kind: e.kind, path: e.path, name: e.name, reason: 'deleted' });
    await put(key, null);
    changes++;
  }
  pass.changes += changes;
  if (queue.length) {
    await save({ pass });
    return { changes, complete: false };
  }

  // A move whose new key this scope already held when the call began needs the journal no longer.
  const settled = Object.keys(moves).filter((key) => committed.get(key) === moves[key]!.itemId);
  if (settled.length) {
    for (const key of settled) delete moves[key];
    await writeJournal(io, MOVES, moves);
  }
  delete binding.pass;
  await save({ lastSync: { syncedAt: nowOf(config).toISOString(), changes: pass.changes, skipped: pass.skipped } });
  return { changes, complete: true };
}

// ── writes ───────────────────────────────────────────────────────────────────

export async function dispatchS3Context(ctx: ScopedConnectionContext, event: DomainEvent, config: { journalOperation: string } & S3Options): Promise<void> {
  const io: Io = { ctx, client: clientFor(ctx.fetch, s3Secret.parse({ ...ctx.secret }), config), prefix: prefixOf(ctx), journalOperation: config.journalOperation, options: config };
  if (event.type === S3_FILES_EVENT) return writeFiles(io, event);
  if (event.type === S3_ITEMS_EVENT) {
    const req = s3ItemsPayload.parse(event.payload).request;
    if (req.op === 'delete') return deleteItems(io, req.items);
    if (req.op === 'mkdir') return makeFolder(io, cleanRel(req.path, 'folder'));
    return req.kind === 'file' ? moveFile(io, cleanRel(req.from, 'source'), cleanRel(req.to, 'target')) : moveFolder(io, cleanRel(req.from, 'source'), cleanRel(req.to, 'target'));
  }
  throw new ConnectorRefusal(`s3 does not handle '${event.type}'`);
}

/** A 412 on a create-only PUT: is the object there one this very write made? */
async function ownObject(io: Io, key: string, tag: string) {
  const head = await io.client.head(key, [WRITE_TAG]);
  return head && head.meta[WRITE_TAG] === tag ? head : null;
}

async function writeFiles(io: Io, event: DomainEvent): Promise<void> {
  const payload = fileSourceWriteRequest.parse(event.payload);
  const directory = payload.directory.split('/').map((s) => s.trim()).filter(Boolean).join('/');
  if (directory && !validPath(directory)) throw new ConnectorRefusal(`'${payload.directory}' is not a valid folder`);
  for (const f of payload.files) {
    const opened = await io.ctx.attachments.open(f.attachmentId);
    if (!opened) throw new ConnectorRefusal(`attachment ${f.attachmentId} is not one this event's entity holds`);
    if (opened.record.size !== f.size || opened.body.length !== f.size) {
      throw new ConnectorRefusal(`attachment ${f.attachmentId} is not the ${f.size} bytes the event declared`);
    }
    const wanted = (f.name ?? opened.record.filename).trim().replace(/[/\\]/g, '-');
    if (!validSegment(wanted)) throw new ConnectorRefusal(`'${wanted}' is not a valid file name`);
    const tag = `${event.id}:${f.attachmentId}`;
    const put = (key: string, ifNoneMatch: boolean) =>
      io.client.put(key, opened.body, { contentType: opened.contentType, ifNoneMatch, meta: { [WRITE_TAG]: tag } });

    let name = wanted;
    let etag: string | null = null;
    if (payload.conflict === 'replace') {
      const key = `${io.prefix}${join(directory, name)}`;
      // Redelivered after it succeeded (a lost answer, or a later file of the event failed): the
      // object is already this write's, so it is not written again.
      etag = (await ownObject(io, key, tag))?.etag ?? (await put(key, false)).etag;
    } else {
      for (let n = 0; ; n++) {
        if (n > 0 && (payload.conflict === 'fail' || n > MAX_RENAME)) {
          throw new ConnectorRefusal(`'${join(directory, wanted)}' already exists in the bucket`);
        }
        name = n === 0 ? wanted : withSuffix(wanted, String(n));
        const key = `${io.prefix}${join(directory, name)}`;
        try {
          etag = (await put(key, true)).etag;
          break;
        } catch (e) {
          if (!(e instanceof S3Error && e.status === 412)) throw e;
          const own = await ownObject(io, key, tag);
          if (own) {
            etag = own.etag;
            break;
          }
        }
      }
    }
    // Written under another name ('rename' found the name taken), the object is not the vertical's
    // file: the sync lands it as a new item from its own bytes, never with this file's attachment.
    if (name !== wanted) continue;
    const key = `${io.prefix}${join(directory, name)}`;
    const held = (await io.ctx.state.get(itemKey(key))) as ItemEntry | undefined;
    const r = opened.record;
    await io.ctx.state.put(itemKey(key), {
      kind: 'file', itemId: held?.itemId ?? key, path: join(directory, name), name, size: f.size,
      attachmentId: held?.attachmentId ?? null,
      ...(etag ? { etag } : {}),
      ...(held?.seenIn ? { seenIn: held.seenIn } : {}),
      echo: { id: r.id, filename: r.filename, contentType: r.contentType, size: r.size, sha256: r.sha256 },
    } satisfies ItemEntry);
  }
}

async function makeFolder(io: Io, path: string): Promise<void> {
  try {
    await io.client.put(`${io.prefix}${path}/`, new Uint8Array(0), { ifNoneMatch: true });
  } catch (e) {
    // Already there is what was asked for.
    if (!(e instanceof S3Error && e.status === 412)) throw e;
  }
}

/** Every key under `keyPrefix`, up to `limit` (and whether there were more). */
async function keysUnder(io: Io, keyPrefix: string, limit: number) {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await io.client.list({ prefix: keyPrefix, maxKeys: Math.min(1000, limit + 1 - keys.length), ...(token ? { continuationToken: token } : {}) });
    keys.push(...res.objects.map((o) => o.key));
    token = res.truncated ? res.nextContinuationToken : undefined;
  } while (token && keys.length <= limit);
  return { keys: keys.slice(0, limit), more: keys.length > limit || !!token };
}

/**
 * Land the delete of a held item and forget it. Without the landing the vertical would keep the
 * item: the sync's verify step only asks about items it still holds.
 */
async function landRemoved(io: Io, key: string) {
  const held = (await io.ctx.state.get(itemKey(key))) as ItemEntry | undefined;
  if (!held) return;
  await io.ctx.land(fileSourceChange.parse({ change: 'delete', connectionId: io.ctx.connection.id, itemId: held.itemId, kind: held.kind, path: held.path, name: held.name, reason: 'deleted' }));
  await io.ctx.state.put(itemKey(key), null);
}

async function deleteItems(io: Io, list: { path: string; kind: 'file' | 'folder' }[]): Promise<void> {
  let budget = DELETES_PER_CALL;
  for (const item of list) {
    const path = cleanRel(item.path, item.kind);
    // What was removed stays removed; the redelivery carries on from what is left.
    if (budget <= 0) throw new Error(`more items to delete; continuing on the next delivery`);
    if (item.kind === 'file') {
      const key = `${io.prefix}${path}`;
      await io.client.delete(key);
      await landRemoved(io, key);
      budget--;
      continue;
    }
    const folderKey = `${io.prefix}${path}/`;
    const { keys, more } = await keysUnder(io, folderKey, budget);
    for (const key of keys) {
      await io.client.delete(key);
      await landRemoved(io, key);
    }
    budget -= keys.length;
    if (more) throw new Error(`folder '${path}' has more objects to delete; continuing on the next delivery`);
    // Folders implied by the keys (and any held item no longer in the bucket) go with it.
    const held = (await io.ctx.state.list(itemKey(folderKey))).map((row) => row.key.slice(ITEM.length));
    for (const key of held.sort((a, b) => b.length - a.length)) await landRemoved(io, key);
  }
}

async function recordMoves(io: Io, pairs: [to: string, itemId: string][]) {
  const moves = (await readJournal<Moves>(io, MOVES)) ?? {};
  const at = nowOf(io.options).toISOString();
  // A day-old entry has been through a sync long since; dropping it keeps the journal small.
  const cutoff = Date.parse(at) - 24 * 60 * 60 * 1000;
  for (const [key, m] of Object.entries(moves)) if (Date.parse(m.at) < cutoff) delete moves[key];
  for (const [to, itemId] of pairs) moves[to] = { itemId, at };
  await writeJournal(io, MOVES, moves);
}

/** Carry a held entry to its new key, keeping its id. */
async function moveEntry(io: Io, from: string, to: string, path: string) {
  const held = (await io.ctx.state.get(itemKey(from))) as ItemEntry | undefined;
  if (!held) return;
  await io.ctx.state.put(itemKey(to), { ...held, path, name: baseName(path), previousPath: held.previousPath ?? held.path });
  await io.ctx.state.put(itemKey(from), null);
}

/** Did a move this connector began record `key` as the new home of `itemId`? */
async function movedHere(io: Io, key: string, itemId: string) {
  return ((await readJournal<Moves>(io, MOVES)) ?? {})[key]?.itemId === itemId;
}

/**
 * Is the object at `key` this connector's own copy of `itemId`? The journal says so until it is
 * pruned (after a day, or once a sync settles the key); from then on the held state does, since
 * the sync gave the copied key the id the journal carried over.
 */
async function isOwnMove(io: Io, key: string, itemId: string) {
  if (await movedHere(io, key, itemId)) return true;
  const held = (await io.ctx.state.get(itemKey(key))) as ItemEntry | undefined;
  return held?.itemId === itemId;
}

async function idFor(io: Io, key: string) {
  const held = (await io.ctx.state.get(itemKey(key))) as ItemEntry | undefined;
  return held?.itemId ?? key;
}

async function moveFile(io: Io, from: string, to: string): Promise<void> {
  if (from === to) return;
  const src = `${io.prefix}${from}`, dst = `${io.prefix}${to}`;
  const [there, here] = await Promise.all([io.client.head(src), io.client.head(dst)]);
  const id = await idFor(io, src);
  if (!there && here) {
    const held = (await io.ctx.state.get(itemKey(src))) as ItemEntry | undefined;
    // Done by an earlier delivery, and the sync has carried the entry over already.
    if (!held) return;
    // Done by an earlier delivery whose answer was lost, or the source went and someone else's
    // object is at the target: only this move's own record may carry the held entry there.
    if (!(await isOwnMove(io, dst, id))) throw new ConnectorRefusal(`'${from}' is not in the bucket`);
    return moveEntry(io, src, dst, to);
  }
  if (!there) throw new ConnectorRefusal(`'${from}' is not in the bucket`);
  // Both there: an earlier delivery copied and then lost the delete, or someone else's object.
  const resumed = !!here && (await isOwnMove(io, dst, id));
  if (here && !resumed) throw new ConnectorRefusal(`'${to}' already exists in the bucket`);
  // The copy keeps the source's ETag; a different one means the target was written since, and
  // deleting the source would lose its content.
  if (resumed && here.etag !== there.etag) throw new ConnectorRefusal(`'${to}' changed in the bucket after the move copied it; '${from}' is kept`);
  if (!resumed) {
    await recordMoves(io, [[dst, id]]);
    await io.client.copy(src, dst);
  }
  await io.client.delete(src);
  await moveEntry(io, src, dst, to);
}

async function moveFolder(io: Io, from: string, to: string): Promise<void> {
  if (from === to) return;
  if (to.startsWith(`${from}/`)) throw new ConnectorRefusal(`'${from}' cannot move into itself`);
  const srcPrefix = `${io.prefix}${from}/`, dstPrefix = `${io.prefix}${to}/`;
  const started = await movedHere(io, dstPrefix, await idFor(io, srcPrefix));
  const { keys, more } = await keysUnder(io, srcPrefix, MAX_MOVE_OBJECTS);
  if (more) throw new ConnectorRefusal(`'${from}' holds more than ${MAX_MOVE_OBJECTS} objects; move it in the bucket itself`);
  if (!started) {
    if ((await io.client.list({ prefix: dstPrefix, maxKeys: 1 })).objects.length) throw new ConnectorRefusal(`'${to}' already exists in the bucket`);
    // Every key the move will make, files and folders, keeps the id it had.
    const pairs: [string, string][] = [[dstPrefix, await idFor(io, srcPrefix)]];
    const folders = new Set<string>();
    for (const key of keys) {
      const rest = key.slice(srcPrefix.length);
      pairs.push([`${dstPrefix}${rest}`, await idFor(io, key)]);
      const parts = rest.split('/').slice(0, -1);
      for (let i = 1; i <= parts.length; i++) folders.add(`${parts.slice(0, i).join('/')}/`);
    }
    for (const f of folders) pairs.push([`${dstPrefix}${f}`, await idFor(io, `${srcPrefix}${f}`)]);
    await recordMoves(io, pairs);
  }
  for (const key of keys) {
    const rest = key.slice(srcPrefix.length);
    await io.client.copy(key, `${dstPrefix}${rest}`);
    await io.client.delete(key);
  }
  // The folder's own entry (`a/`) is under its prefix too; its `rest` is empty.
  for (const row of await io.ctx.state.list(itemKey(srcPrefix))) {
    const key = row.key.slice(ITEM.length);
    const rest = key.slice(srcPrefix.length).replace(/\/$/, '');
    await moveEntry(io, key, `${dstPrefix}${key.slice(srcPrefix.length)}`, rest ? join(to, rest) : to);
  }
}

// ── bytes ────────────────────────────────────────────────────────────────────

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', svg: 'image/svg+xml', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  xml: 'application/xml', html: 'text/html', eml: 'message/rfc822', mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zip: 'application/zip',
};
function contentTypeOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? (CONTENT_TYPES[name.slice(dot + 1).toLowerCase()] ?? null) : null;
}
