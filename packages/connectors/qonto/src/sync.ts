/**
 * A Qonto business account as a read-only file source. Every record lands as its own item, because
 * what comes next (actions on a new item) needs one event per transaction, receipt or no receipt.
 *
 * ```
 * Transactions/2026/11/2026-11-03 Adobe -59.99 EUR (1a2b3c4d).json
 * Transactions/2026/11/2026-11-03 Adobe -59.99 EUR (1a2b3c4d).pdf     its receipt
 * Supplier invoices/2026/11/…   Client invoices/2026/11/…   Credit notes/2026/11/…
 * Statements/2026/2026-11 Main account (1a2b3c4d).pdf
 * ```
 *
 * - **Names are stable.** The short id keeps a name unique without reading its siblings, and a path,
 *   once given, is kept: Qonto tidying a counterparty name never renames a landed file.
 * - **Reads are resumable.** Each page saves where the next starts. A call stops at
 *   {@link OUTBOUND_BUDGET}, under the platform's limit of 100 outbound uses, or at a 429, and the
 *   next call carries on; items already landed are skipped by their fingerprint.
 * - **Transactions** are read by `updated_at` ascending, moving the cursor rather than the page, so
 *   Qonto's cap of 10,000 results per query never truncates a long history. Qonto does not document
 *   whether attaching a receipt bumps `updated_at`, so once a day the last {@link RECHECK_MS} are
 *   read again.
 * - **The presigned file URLs** last 30 minutes and are read in the call that listed them.
 */
import { FILE_SOURCE_MAX_FILE_BYTES, fileSourceChange, fileSourceUpsertAnswer, type FileSourceChange } from '@substrat-run/contracts';
import { connectorUploadBody, deadlineFetch, type FetchLike, type ScopedConnectionContext } from '@substrat-run/kernel';
import { createQontoClient, QontoError, qontoSecret, type QontoAttachment, type QontoBankAccount, type QontoClient, type QontoTransaction } from './client.js';

/** Outbound calls one sweep makes; the platform records at most 100. */
export const OUTBOUND_BUDGET = 90;
export const PAGE_SIZE = 25;
/** How far behind the last pass the page-numbered lists read again. */
export const OVERLAP_MS = 24 * 60 * 60 * 1000;
/** How far back the daily pass re-reads transactions, for receipts attached after settling. */
export const RECHECK_MS = 45 * 24 * 60 * 60 * 1000;
const RECHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60_000;

export interface QontoSyncOptions { apiBase?: string; now?: () => Date; budget?: number }
export interface QontoSyncResult { changes: number; complete: boolean }

const PROGRESS_KEY = 'qonto:progress';
const itemKey = (id: string) => `qonto:item:${id}`;
const folderKey = (path: string) => `qonto:folder:${path}`;

interface StreamCursor { pass: string; from?: string; page: number }
interface Progress {
  pass?: { startedAt: string; done: string[]; recheck: boolean };
  streams: Record<string, StreamCursor>;
  lastRecheck?: string;
}
interface ItemEntry { path: string; fingerprint: string; attachmentId: string | null; tooLarge?: boolean; attachments?: string[] }

/** Stops the call cleanly, keeping everything landed so far. */
class StopForNow extends Error {}

// ── naming ───────────────────────────────────────────────────────────────────

const clean = (value: string | null | undefined, fallback: string) => {
  const text = (value ?? '').replace(/[\/\\\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  return !text || text === '.' || text === '..' ? fallback : text;
};
const shortId = (id: string) => id.replace(/-/g, '').slice(0, 8);
const dayOf = (iso: string | null | undefined) => /^\d{4}-\d{2}-\d{2}/.test(iso ?? '') ? iso!.slice(0, 10) : '0000-00-00';
const monthDir = (root: string, day: string) => `${root}/${day.slice(0, 4)}/${day.slice(5, 7)}`;

const EXTENSIONS: Record<string, string> = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/heic': 'heic', 'image/webp': 'webp', 'application/xml': 'xml', 'text/xml': 'xml' };
function extensionOf(fileName: string | null | undefined, contentType: string | null | undefined) {
  const fromName = /\.([a-z0-9]{1,8})$/i.exec(fileName ?? '')?.[1]?.toLowerCase();
  return fromName ?? EXTENSIONS[(contentType ?? '').toLowerCase()] ?? 'bin';
}
export function transactionStem(tx: QontoTransaction) {
  const sign = tx.side === 'debit' ? '-' : '';
  return `${dayOf(tx.settled_at ?? tx.emitted_at)} ${clean(tx.clean_counterparty_name ?? tx.label, 'Transaction')} ${sign}${Number(tx.amount).toFixed(2)} ${clean(tx.currency, '')} (${shortId(tx.id)})`;
}
const partyName = (client?: { name?: string | null; first_name?: string | null; last_name?: string | null } | null) =>
  client?.name ?? [client?.first_name, client?.last_name].filter(Boolean).join(' ');

// ── the sync ─────────────────────────────────────────────────────────────────

/** A binding has nothing to choose: the space mirrors the whole account, and never writes to it. */
export async function bindQontoContext(ctx: ScopedConnectionContext, options: Pick<QontoSyncOptions, 'apiBase'> = {}): Promise<Record<string, unknown>> {
  const organization = await clientOf(ctx, options, ctx.fetch).organization();
  return { folder: '', canUpload: false, organization: organization.slug };
}

function clientOf(ctx: ScopedConnectionContext, options: Pick<QontoSyncOptions, 'apiBase'>, fetchImpl: FetchLike): QontoClient {
  return createQontoClient({ secret: qontoSecret.parse(ctx.secret), fetch: fetchImpl, ...(options.apiBase ? { apiBase: options.apiBase } : {}) });
}

interface Stream { key: string; read(cursor: StreamCursor): Promise<boolean> }

export async function syncQontoContext(ctx: ScopedConnectionContext, options: QontoSyncOptions = {}): Promise<QontoSyncResult> {
  const now = options.now?.() ?? new Date();
  let spent = 0;
  const limit = options.budget ?? OUTBOUND_BUDGET;
  const bounded = deadlineFetch(ctx.fetch, REQUEST_TIMEOUT_MS);
  const budgeted: FetchLike = (input, init) => {
    if (spent >= limit) throw new StopForNow();
    spent++;
    return bounded(input, init);
  };
  const client = clientOf(ctx, options, budgeted);
  let changes = 0;

  const invoke = (change: FileSourceChange) => ctx.invoke(ctx.scope.operation!, fileSourceChange.parse(change));
  const connectionId = ctx.connection.id;
  const getItem = async (id: string) => (await ctx.state.get(itemKey(id))) as ItemEntry | undefined;

  const ensureFolders = async (dir: string) => {
    let path = '';
    for (const name of dir.split('/')) {
      path = path ? `${path}/${name}` : name;
      if (await ctx.state.get(folderKey(path))) continue;
      await invoke({ change: 'upsert', connectionId, itemId: `folder:${path}`, kind: 'folder', path, name, previousPath: null, size: null, contentType: null, lastModifiedAt: null, webUrl: null, content: null });
      await ctx.state.put(folderKey(path), true);
      changes++;
    }
  };

  /** Land one file unless its fingerprint says this version already did. */
  const landFile = async (item: { id: string; dir: string; name: string; fingerprint: string; contentType: string; size: number | null; modified: string | null; bytes: () => Promise<Uint8Array> }, extra: Pick<ItemEntry, 'attachments'> = {}) => {
    const prior = await getItem(item.id);
    if (prior && prior.fingerprint === item.fingerprint && (prior.attachmentId || prior.tooLarge)) return;
    const path = prior?.path ?? `${item.dir}/${item.name}`;
    const name = path.slice(path.lastIndexOf('/') + 1);
    await ensureFolders(path.slice(0, path.lastIndexOf('/')));
    const tooLarge = item.size !== null && item.size > FILE_SOURCE_MAX_FILE_BYTES;
    // Bytes first: a call stopped by its budget must not leave an empty file showing in the drive.
    const bytes = tooLarge ? null : await item.bytes();
    const answer = await invoke({ change: 'upsert', connectionId, itemId: item.id, kind: 'file', path, name, previousPath: null, size: item.size, contentType: item.contentType, lastModifiedAt: item.modified, webUrl: null, content: tooLarge ? 'too-large' : 'follows' });
    changes++;
    const entry: ItemEntry = { path, fingerprint: item.fingerprint, attachmentId: prior?.attachmentId ?? null, tooLarge, ...extra };
    const target = fileSourceUpsertAnswer.safeParse(answer);
    if (bytes && target.success && target.data.entity) {
      const record = await ctx.attachments.upload({ entity: target.data.entity, filename: name, contentType: item.contentType, visibility: 'internal', body: connectorUploadBody(bytes) });
      await invoke({ change: 'content', connectionId, itemId: item.id, kind: 'file', path, name, attachment: record, replaces: entry.attachmentId });
      entry.attachmentId = record.id;
    }
    await ctx.state.put(itemKey(item.id), entry);
  };

  const landDocument = (id: string, dir: string, stem: string, attachmentId: string | null | undefined, modified: string | null) => {
    // A client invoice's file is generated after the invoice; the overlap finds it next pass.
    if (!attachmentId) return Promise.resolve();
    return getItem(id).then(async (prior) => {
      if (prior?.fingerprint === attachmentId && prior.attachmentId) return;
      const file = await client.attachment(attachmentId);
      await landFile(fileItem(id, dir, stem, file, attachmentId, modified));
    });
  };
  const fileItem = (id: string, dir: string, stem: string, file: QontoAttachment, fingerprint: string, modified: string | null) => ({
    id, dir, name: `${stem}.${extensionOf(file.file_name, file.file_content_type)}`, fingerprint,
    contentType: file.file_content_type || 'application/octet-stream',
    size: Number.isFinite(Number(file.file_size)) && file.file_size !== null && file.file_size !== undefined ? Number(file.file_size) : null,
    modified, bytes: () => client.download(file.url),
  });

  const landTransaction = async (tx: QontoTransaction) => {
    const id = `tx:${tx.id}`, stem = transactionStem(tx);
    const day = dayOf(tx.settled_at ?? tx.emitted_at), dir = monthDir('Transactions', day);
    const files = tx.attachments ?? [];
    const attachments = files.map((f) => f.id);
    const { attachments: _urls, logo: _logo, ...record } = tx;
    const json = new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`);
    const prior = await getItem(id);
    // Bumped by the receipt list too, in case attaching one leaves `updated_at` alone.
    await landFile({ id, dir, name: `${stem}.json`, fingerprint: `${tx.updated_at}|${attachments.join(',')}`, contentType: 'application/json', size: json.byteLength, modified: tx.settled_at ?? tx.emitted_at, bytes: async () => json }, { attachments });
    // A receipt taken off the transaction goes first, so its name is free for the next one.
    for (const gone of (prior?.attachments ?? []).filter((a) => !attachments.includes(a))) {
      const held = await getItem(`att:${gone}`);
      if (!held) continue;
      await invoke({ change: 'delete', connectionId, itemId: `att:${gone}`, kind: 'file', path: held.path, name: held.path.slice(held.path.lastIndexOf('/') + 1), reason: 'deleted' });
      await ctx.state.put(itemKey(`att:${gone}`), null);
      changes++;
    }
    for (const [index, file] of files.entries()) {
      await landFile(fileItem(`att:${file.id}`, dir, index === 0 ? stem : `${stem} (${shortId(file.id)})`, file, file.id, tx.settled_at ?? tx.emitted_at));
    }
  };

  /** One page of a page-numbered list; `true` once its last page has been read. */
  const paged = async (cursor: StreamCursor, rows: unknown[]) => {
    if (rows.length < PAGE_SIZE) return true;
    cursor.page++;
    return false;
  };
  const transactionStream = (account: QontoBankAccount): Stream => ({
    key: `transactions:${account.id}`,
    read: async (cursor) => {
      const page = await client.transactions({ bankAccountId: account.id, ...(cursor.from ? { updatedFrom: cursor.from } : {}), page: cursor.page, perPage: PAGE_SIZE });
      for (const tx of page) await landTransaction(tx);
      const last = page[page.length - 1]?.updated_at;
      if (page.length < PAGE_SIZE) {
        // The next pass starts here; the filter is inclusive, so this row is read again and skipped.
        if (last) cursor.from = last;
        return true;
      }
      // Move the cursor when it can move; a full page all stamped alike can only page on.
      if (last !== cursor.from) { cursor.from = last; cursor.page = 1; } else cursor.page++;
      return false;
    },
  });
  const streams = (accounts: QontoBankAccount[]): Stream[] => [
    ...accounts.map(transactionStream),
    { key: 'supplier-invoices', read: async (c) => {
      const rows = await client.supplierInvoices({ ...(c.from ? { updatedFrom: c.from } : {}), page: c.page, perPage: PAGE_SIZE });
      for (const r of rows) { const day = dayOf(r.issue_date ?? r.updated_at); await landDocument(`supplier:${r.id}`, monthDir('Supplier invoices', day), `${day} ${clean(r.supplier_name, 'Supplier')} ${clean(r.invoice_number, 'invoice')} (${shortId(r.id)})`, r.attachment_id, r.updated_at ?? null); }
      return paged(c, rows);
    } },
    { key: 'client-invoices', read: async (c) => {
      const rows = await client.clientInvoices({ ...(c.from ? { updatedFrom: c.from } : {}), page: c.page, perPage: PAGE_SIZE });
      for (const r of rows) { const day = dayOf(r.issue_date); await landDocument(`client:${r.id}`, monthDir('Client invoices', day), `${day} ${clean(partyName(r.client), 'Client')} ${clean(r.number, 'invoice')} (${shortId(r.id)})`, r.attachment_id, null); }
      return paged(c, rows);
    } },
    { key: 'credit-notes', read: async (c) => {
      const rows = await client.creditNotes({ ...(c.from ? { createdFrom: c.from } : {}), page: c.page, perPage: PAGE_SIZE });
      for (const r of rows) { const day = dayOf(r.issue_date ?? r.created_at); await landDocument(`credit:${r.id}`, monthDir('Credit notes', day), `${day} ${clean(partyName(r.client), 'Client')} ${clean(r.number, 'credit note')} (${shortId(r.id)})`, r.attachment_id, r.created_at ?? null); }
      return paged(c, rows);
    } },
    { key: 'statements', read: async (c) => {
      const rows = await client.statements({ page: c.page, perPage: PAGE_SIZE });
      for (const r of rows) {
        const [month = '00', year = '0000'] = r.period.split('-');
        const account = accounts.find((a) => a.id === r.bank_account_id);
        await landFile({ id: `statement:${r.id}`, dir: `Statements/${year}`, name: `${year}-${month} ${clean(account?.name, 'Account')} (${shortId(r.id)}).${extensionOf(r.file.file_name, r.file.file_content_type)}`, fingerprint: r.id, contentType: r.file.file_content_type || 'application/pdf', size: r.file.file_size ?? null, modified: null, bytes: () => client.download(r.file.file_url) });
      }
      return paged(c, rows);
    } },
  ];

  const progress = ((await ctx.state.get(PROGRESS_KEY)) as Progress | undefined) ?? { streams: {} };
  const save = () => ctx.state.put(PROGRESS_KEY, progress);
  const recheckDue = !progress.lastRecheck || now.getTime() - Date.parse(progress.lastRecheck) >= RECHECK_EVERY_MS;
  const pass = (progress.pass ??= { startedAt: now.toISOString(), done: [], recheck: recheckDue });

  try {
    const organization = await client.organization();
    for (const stream of streams(organization.bank_accounts)) {
      if (pass.done.includes(stream.key)) continue;
      const held = progress.streams[stream.key];
      const isTx = stream.key.startsWith('transactions:');
      let cursor: StreamCursor;
      if (held?.pass === pass.startedAt) cursor = held;
      else {
        cursor = { pass: pass.startedAt, page: 1, ...(held?.from ? { from: held.from } : {}) };
        const floor = new Date(now.getTime() - RECHECK_MS).toISOString();
        if (isTx && pass.recheck && cursor.from && cursor.from > floor) cursor.from = floor;
      }
      progress.streams[stream.key] = cursor;
      for (let finished = false; !finished;) {
        finished = await stream.read(cursor);
        await save();
      }
      // A transaction cursor stands on the last row it read; the others restart behind this pass.
      if (!isTx) cursor.from = new Date(Date.parse(pass.startedAt) - OVERLAP_MS).toISOString();
      pass.done.push(stream.key);
      await save();
    }
  } catch (error) {
    if (error instanceof StopForNow || (error instanceof QontoError && error.status === 429)) {
      await save();
      return { changes, complete: false };
    }
    throw error;
  }
  if (pass.recheck) progress.lastRecheck = pass.startedAt;
  delete progress.pass;
  await save();
  return { changes, complete: true };
}
