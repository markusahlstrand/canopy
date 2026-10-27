/**
 * An a3doc folder as a Substrat file source (#2 after Microsoft 365 channel files): reads are a
 * sync that lands `fileSourceChange` through the vertical's own operation, writes are the
 * `a3doc.files-requested` event. Design: canopy `documentation/planning/connected-spaces-file-sources.md`.
 *
 * - **The binding** (`bindA3docScope`) names a container by its path under the root ("Todos"),
 *   resolves it to the container id once, and keeps the id. It also records whether the signed-in
 *   a3doc user may upload at all (`canUpload`); a binding that may not refuses every write.
 * - **Item ids.** A file is `<documentId>@<containerId>`, because a3doc files one document in
 *   several containers and each placement is its own item. A folder is `c<containerId>`.
 * - **Names are stable.** A name, once given, is kept in connector state and changes only when that
 *   item's own a3doc title (or a folder's own name) changes. A clash suffixes the item that arrives
 *   later with its document number (a folder with its container id), so removing a sibling never
 *   renames another item. A document this connector uploaded gets the name its request asked for.
 * - **Reads.** a3doc has no change feed: documents are read newest-modified first, down to the last
 *   high-water mark minus {@link OVERLAP_MS}, which covers the October hour that happens twice and
 *   ties on the mark itself. Wall-clock `DateModified` is not trusted alone as a version: the item
 *   keeps a fingerprint, and an item last modified inside an ambiguous hour has its bytes compared
 *   with the landed sha256 on the next full pass. A full pass runs at least every
 *   {@link FULL_PASS_EVERY_MS}.
 * - **Deletes land only on an answer about that item.** A placement missing from its document's own
 *   `ContainersId` is `moved-out`. A held item a full pass never presented is checked on its own: a
 *   title search scoped to its container, then `Download` of the document. Never a walk's silence.
 *   A folder missing from the tree is held, not deleted: a3doc offers no read about one container.
 * - **Writes** add documents; a3doc can never replace one, so `conflict: 'replace'` is refused. A
 *   ledger row per event records each upload as `attempted` before the call, so a retry whose
 *   answer was lost first looks for the document it may already have made and adopts it only when
 *   its bytes hash to the attachment's.
 */
import {
  FILE_SOURCE_MAX_FILE_BYTES,
  fileSourceChange,
  fileSourceUpsertAnswer,
  fileSourceWriteRequest,
  scopeId as scopeIdSchema,
  substratError,
  tenantId as tenantIdSchema,
  type ConnectionId,
  type DomainEvent,
  type FileSourceChange,
} from '@substrat-run/contracts';
import { bytesStream, connectorUploadBody, type ConnectorHandler, type ConnectorOptions, type ScopeHost, type SizedByteStream, type ConnectorContext, type ScopedConnectionContext } from '@substrat-run/kernel';
import {
  A3DOC_ROOT_CONTAINER,
  canUploadAs,
  isAmbiguousA3Date,
  parseA3Date,
  type A3Container,
  type A3docClient,
  type A3Document,
} from './client.js';
import { A3DOC_PROVIDER, a3docSecret, clientFor, nowOf, openA3docConnection, type A3docOptions } from './connection.js';

// ── the public contract ──────────────────────────────────────────────────────

/** The event a vertical emits to put files in its bound a3doc folder. */
export const A3DOC_FILES_EVENT = 'a3doc.files-requested';

/** How far behind the high-water mark an incremental pass reads again. */
export const OVERLAP_MS = 2 * 60 * 60 * 1000;
/** How often a pass is a full one, whatever the cursor says. */
export const FULL_PASS_EVERY_MS = 24 * 60 * 60 * 1000;
/** Documents per page of `GetDocumentsExtended`. */
export const PAGE_SIZE = 100;
/** Pages one call reads before it stops and leaves the rest to the next. */
export const SYNC_PAGES_PER_CALL = 20;
/** Held items one call checks on their own after a full pass did not present them. */
export const SYNC_VERIFY_PER_CALL = 50;
/** A sync's per-request timeout: long enough to download a file at the cap. */
export const SYNC_TIMEOUT_MS = 120_000;

// ── state ────────────────────────────────────────────────────────────────────

const KEY = 'a3doc:';
const BINDING_PREFIX = `${KEY}binding:`;
const bindingKey = (scope: string) => `${BINDING_PREFIX}${scope}`;
/** Per item. Keyed by the bound container too, so a binding to another container starts clean. */
const itemPrefix = (b: Pick<A3docBinding, 'scopeId' | 'containerId'>) => `${KEY}item:${b.scopeId}:${b.containerId}:`;
const writeKey = (eventId: string) => `${KEY}write:${eventId}`;
/** The name an upload asked for, by the document a3doc made for it. */
const requestedKey = (scope: string, documentId: string) => `${KEY}requested:${scope}:${documentId}`;

export interface A3docBinding {
  scopeId: string;
  tenantId: string;
  vertical: string;
  /** The vertical's operation each change lands through. */
  operation: string;
  /** The permission that operation checks, held by the connection on the scope. */
  permission: string;
  /** The container's path under the root as it was bound; `''` is the root itself. */
  folder: string;
  containerId: number;
  boundAt: string;
  /** Whether the a3doc user may upload (its role); a binding that may not refuses every write. */
  canUpload: boolean;
  /** The customer uploads are filed under when the credential names none: read from the folder at bind. */
  customerId?: string;
  /** The newest `DateModified` landed, as UTC ISO; absent until the first full pass completed. */
  highWater?: string;
  /** When the last full pass completed. */
  lastFull?: string;
  /** A pass in progress, saved after every page so a cut-off pass resumes there. */
  pass?: SyncPass;
  lastSync?: { syncedAt: string; changes: number; unplaced?: number };
  /** Set when the bound container is gone from the tree; the binding refuses until bound again. */
  folderMissing?: { since: string };
}

interface SyncPass {
  id: string;
  full: boolean;
  /** The next page of documents to read. */
  page: number;
  startedAt: string;
  changes: number;
  /** The newest `DateModified` this pass has seen, UTC ISO. */
  highWater?: string;
  /** Set once every page was read: held items the pass did not present, still to be checked one by one. */
  verify?: string[];
}

interface ItemEntry {
  kind: 'file' | 'folder';
  /** The container the item sits in (a folder's parent; a file's own placement). */
  parentId: number;
  path: string;
  name: string;
  /** What the name was made from: a folder's a3doc name, a file's title + type. */
  source: string;
  documentId?: string;
  /** The document's a3doc title: what the per-item check searches by. */
  title?: string;
  code?: number;
  dateModified?: string;
  size?: number;
  /** The landed content's attachment and its sha256. */
  attachmentId: string | null;
  sha256?: string | null;
  /** Held without bytes: over the size cap. */
  tooLarge?: boolean;
  /** `dateModified` names a wall-clock time that happened twice. */
  ambiguous?: boolean;
  seenIn?: string;
}

// ── naming ───────────────────────────────────────────────────────────────────

/** A name a path segment can carry: no slashes, never empty. */
const segment = (name: string | undefined, fallback: string) => {
  const clean = (name ?? '').trim().replace(/[\/\\]/g, '-');
  return !clean || clean === '.' || clean === '..' ? fallback : clean;
};
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const extOf = (doc: A3Document) => (doc.Type ?? '').replace(/^\.+/, '').trim().toLowerCase();
const sourceOf = (doc: A3Document) => `${doc.Title ?? ''}${doc.Type ?? ''}`;

/** `<Title>.<ext>`, without doubling an extension the title already ends in. */
export function fileNameOf(doc: A3Document): string {
  const ext = extOf(doc);
  let stem = segment(doc.Title, doc.Id);
  if (ext && stem.toLowerCase().endsWith(`.${ext}`)) stem = stem.slice(0, -(ext.length + 1));
  return ext ? `${stem}.${ext}` : stem;
}

/** `Factura.pdf` + `1042` → `Factura (1042).pdf`. */
export function withSuffix(name: string, suffix: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${suffix})${name.slice(dot)}` : `${name} (${suffix})`;
}

// ── the binding ──────────────────────────────────────────────────────────────

/**
 * Declare that a connection syncs one scope with one a3doc container.
 *
 * Refuses a path that does not resolve to a container, and a connection that does not hold the
 * operation's permission on the scope, so a sweep can never be configured to read a folder and
 * then fail to land it.
 */
export async function bindA3docScope(
  host: ScopeHost,
  input: { connectionId: ConnectionId; tenantId: string; scopeId: string; vertical: string; operation: string; permission: string; folder?: string },
  options: A3docOptions,
): Promise<A3docBinding> {
  const tenant = tenantIdSchema.parse(input.tenantId);
  const scope = scopeIdSchema.parse(input.scopeId);
  const granted = await host.connectionGrantsInScope(tenant, scope);
  if (!granted.some((g) => g.connectionId === input.connectionId && g.permission === input.permission)) {
    throw new Error(
      `connection ${input.connectionId} does not hold '${input.permission}' on scope ${input.scopeId} — ` +
        `a sweep would read the folder and then fail to land it. Grant it first, then bind.`,
    );
  }
  const conn = await openA3docConnection(host.admin, options, { id: input.connectionId, tenantId: input.tenantId, vertical: input.vertical });
  const segments = (input.folder ?? '').split('/').map((s) => s.trim()).filter(Boolean);
  const container = containerAtPath(await conn.client.containersTree(), segments);
  if (!container) throw substratError('conflict', `no a3doc folder at '${segments.join('/')}'`);
  const me = await conn.client.userInfo();
  const sample = await conn.client.listDocuments({ containerId: container.id, children: true, pageIndex: 0, pageSize: 1 });

  const binding: A3docBinding = {
    scopeId: input.scopeId,
    tenantId: input.tenantId,
    vertical: input.vertical,
    operation: input.operation,
    permission: input.permission,
    folder: segments.join('/'),
    containerId: container.id,
    boundAt: nowOf(options).toISOString(),
    canUpload: canUploadAs(me.role),
    ...(sample.documents[0]?.CustomerId ? { customerId: sample.documents[0].CustomerId } : {}),
  };
  // The same container bound again keeps its cursor, so a re-bind does not re-land the folder.
  const prior = await readBinding(host, input.connectionId, input.scopeId);
  if (prior && prior.containerId === binding.containerId) {
    if (prior.highWater) binding.highWater = prior.highWater;
    if (prior.lastFull) binding.lastFull = prior.lastFull;
    if (prior.lastSync) binding.lastSync = prior.lastSync;
  }
  await host.admin.putConnectorState(input.connectionId, bindingKey(input.scopeId), binding);
  return binding;
}

/** The container a path of names leads to from the root; `[]` is the root itself. */
function containerAtPath(tree: A3Container[], segments: string[]): A3Container | null {
  return folderUnder(findContainer(tree, A3DOC_ROOT_CONTAINER), segments);
}

/** The container a path of names leads to from `from`; `[]` is `from` itself. */
function folderUnder(from: A3Container | null, segments: string[]): A3Container | null {
  let at = from;
  for (const s of segments) {
    const next: A3Container | undefined = (at?.children ?? []).find((c) => c.name.trim() === s || segment(c.name, String(c.id)) === s);
    if (!next) return null;
    at = next;
  }
  return at;
}

export async function listA3docBindings(host: ScopeHost, connectionId: ConnectionId): Promise<A3docBinding[]> {
  const rows = await host.admin.listConnectorState(connectionId, BINDING_PREFIX);
  return rows.filter((r) => r.value !== null && typeof r.value === 'object').map((r) => r.value as A3docBinding);
}

/** Stop syncing a scope (a tombstone: connector state has no delete). */
export async function unbindA3docScope(host: ScopeHost, connectionId: ConnectionId, scopeId: string): Promise<void> {
  await host.admin.putConnectorState(connectionId, bindingKey(scopeId), null);
}

/** The storage surface shared by self-hosted and vertical-defined execution. */
type A3docState = Pick<ScopeHost['admin'], 'getConnectorState' | 'putConnectorState' | 'listConnectorState'>;

async function readBinding(host: { admin: A3docState }, connectionId: string, scopeId: string) {
  const value = await host.admin.getConnectorState(connectionId as ConnectionId, bindingKey(scopeId));
  return value && typeof value === 'object' ? (value as A3docBinding) : undefined;
}

async function readItems(host: { admin: A3docState }, connectionId: string, binding: A3docBinding) {
  const prefix = itemPrefix(binding);
  const index = new Map<string, ItemEntry>();
  for (const row of await host.admin.listConnectorState(connectionId as ConnectionId, prefix)) {
    if (row.value && typeof row.value === 'object') index.set(row.key.slice(prefix.length), row.value as ItemEntry);
  }
  return index;
}

// ── writes ───────────────────────────────────────────────────────────────────

/** The write ledger row for one event. */
interface WriteLedger {
  status: 'pending' | 'done';
  startedAt: string;
  files: {
    attachmentId: string;
    name: string;
    /** Written before `Upload` is called: what a lost answer is reconciled against. */
    attempted?: { at: string; containerId: number; title: string; sha256: string };
    documentId?: string;
  }[];
}

/**
 * The dispatch: add each named attachment to the bound folder as a new a3doc document.
 *
 * **Idempotency.** `Upload` takes no idempotency key and always adds a document, so the ledger
 * records `attempted` before each upload and the `documentId` after. A redelivery skips every file
 * with an id. A file left `attempted` without one (the answer was lost) is reconciled before it is
 * uploaded again: documents with its title in its container are read back, and one whose bytes hash
 * to the attachment's is adopted as that attempt's. A same-titled document with other bytes, made
 * by a person, is never adopted.
 *
 * `fail` checks the name before uploading. That is best-effort: a3doc has no create-if-absent, so
 * a person in a3doc's web app can add the same name between the check and the upload.
 */
export function a3docFilesConnector(options: A3docOptions): ConnectorHandler {
  return (ctx, event) => dispatchFiles(ctx, event, options);
}

/** Upload engine shared with a vertical-defined connector's fenced capability. */
async function dispatchFiles(
  ctx: { scopeId: string; admin: A3docState; connection(provider: string): Promise<Pick<Awaited<ReturnType<ConnectorContext['connection']>>, 'id' | 'secret' | 'fetch' | 'openAttachmentStream'>> },
  event: DomainEvent,
  options: A3docOptions,
): Promise<void> {
    const payload = fileSourceWriteRequest.parse(event.payload);
    if (payload.conflict === 'replace') {
      throw substratError('validation_failed', "a3doc cannot replace a document: write with 'rename' or 'fail'");
    }
    const conn = await ctx.connection(A3DOC_PROVIDER);
    const binding = await readBinding(ctx, conn.id, ctx.scopeId);
    if (!binding) throw new Error(`no a3doc folder is bound for scope ${ctx.scopeId} on this connection`);
    if (binding.folderMissing) throw folderMissingError();
    if (!binding.canUpload) throw substratError('forbidden', "this a3doc user can't upload: its role may only read");

    const secret = a3docSecret.parse(conn.secret);
    const customerId = secret.customerId ?? binding.customerId;
    if (!customerId) throw new Error('a3doc upload needs a customer: set it on the connection, or bind a folder that has documents');

    const items = await readItems(ctx, conn.id, binding);
    const client = clientFor(conn.fetch, secret, options);
    const directory = payload.directory.replace(/^\/+|\/+$/g, '');
    // The names the sync gave folders first (they may carry a clash suffix); a folder not synced
    // yet is found in a3doc's live tree, under the bound container.
    const containerId = !directory
      ? binding.containerId
      : (folderIdAt(items, directory) ??
        folderUnder(findContainer(await client.containersTree(), binding.containerId), directory.split('/'))?.id ??
        null);
    if (containerId === null) throw substratError('conflict', `a3doc can't create folders, and '${directory}' does not exist there`);
    const namesHere = new Set([...items.values()].filter((e) => e.kind === 'file' && e.parentId === containerId).map((e) => e.name));

    const key = writeKey(event.id);
    const prior = (await ctx.admin.getConnectorState(conn.id, key)) as WriteLedger | undefined;
    if (prior?.status === 'done') {
      for (const file of prior.files) if (file.documentId) {
        await ctx.admin.putConnectorState(conn.id, requestedKey(binding.scopeId, file.documentId), { name: file.name });
      }
      return;
    }
    const ledger: WriteLedger = prior ?? { status: 'pending', startedAt: nowOf(options).toISOString(), files: [] };
    if (!prior) await ctx.admin.putConnectorState(conn.id, key, ledger);

    for (const f of payload.files) {
      let row = ledger.files.find((r) => r.attachmentId === f.attachmentId);
      if (row?.documentId) continue;
      const opened = await conn.openAttachmentStream(f.attachmentId);
      if (!opened) throw new Error(`attachment ${f.attachmentId} is not one this event's entity holds`);
      if (opened.record.size !== f.size || opened.body.length !== f.size) {
        await opened.body.stream.getReader().cancel().catch(() => {});
        throw new Error(`attachment ${f.attachmentId} is not the ${f.size} bytes the event declared`);
      }
      const bytes = await bytesOf(opened.body);
      const sha256 = await sha256Hex(bytes);
      const name = segment(f.name ?? opened.record.filename, f.attachmentId);
      const dot = name.lastIndexOf('.');
      const title = dot > 0 ? name.slice(0, dot) : name;
      const extension = dot > 0 ? name.slice(dot + 1) : '';

      let documentId: string | null = null;
      if (row?.attempted) documentId = await adoptOwnUpload(client, row.attempted);
      if (!documentId) {
        if (payload.conflict === 'fail' && (namesHere.has(name) || (await client.findByTitle({ containerId, children: false, title })).length)) {
          throw substratError('conflict', `'${name}' already exists in that a3doc folder`);
        }
        if (!row) {
          row = { attachmentId: f.attachmentId, name };
          ledger.files.push(row);
        }
        row.attempted = { at: nowOf(options).toISOString(), containerId, title, sha256 };
        await ctx.admin.putConnectorState(conn.id, key, ledger);
        documentId = await client.upload({ containerIds: [containerId], customerId, title, extension, bytes });
      }
      // Either path above left `row` in the ledger: adopted means it was attempted, uploaded means it was just pushed.
      row!.documentId = documentId;
      // The sync names this document as asked, which is how the vertical recognises its own upload.
      await ctx.admin.putConnectorState(conn.id, requestedKey(binding.scopeId, documentId), { name });
      await ctx.admin.putConnectorState(conn.id, key, ledger);
    }
    await ctx.admin.putConnectorState(conn.id, key, { ...ledger, status: 'done' });
}

/** The document an earlier attempt made, if one in its container has its title and its bytes. */
async function adoptOwnUpload(client: A3docClient, attempted: NonNullable<WriteLedger['files'][number]['attempted']>) {
  for (const doc of await client.findByTitle({ containerId: attempted.containerId, children: false, title: attempted.title })) {
    const bytes = await client.download(doc.Id);
    if (bytes && (await sha256Hex(bytes)) === attempted.sha256) return doc.Id;
  }
  return null;
}

/** The container a held folder path names, under the bound folder. */
function folderIdAt(items: Map<string, ItemEntry>, path: string): number | null {
  for (const [id, e] of items) if (e.kind === 'folder' && e.path === path) return Number(id.slice(1));
  return null;
}

const folderMissingError = () => new Error('the bound a3doc folder no longer exists — bind the scope again');

/** Register the write dispatch on a host that runs it (self-host, the control plane). */
export function registerA3docFilesConnector(host: ScopeHost, options: A3docOptions & { id?: string; retry?: ConnectorOptions }): void {
  host.registerConnector(options.id ?? A3DOC_PROVIDER, A3DOC_FILES_EVENT, a3docFilesConnector(options), {
    ...FILES_RETRY,
    ...options.retry,
    provider: A3DOC_PROVIDER,
  });
}

/**
 * Register for ROUTING ONLY, on a CP-less host: the delivery becomes a `connector:a3doc` intent
 * and the control plane, which holds the credential, runs the dispatch.
 */
export function declareA3docFilesConnector(host: ScopeHost, options: { id?: string; retry?: ConnectorOptions } = {}): void {
  host.registerConnector(
    options.id ?? A3DOC_PROVIDER,
    A3DOC_FILES_EVENT,
    async () => {
      throw new Error('a3doc: this host registered the connector for routing only — the dispatching host runs it');
    },
    { ...FILES_RETRY, ...options.retry, provider: A3DOC_PROVIDER },
  );
}

const FILES_RETRY: ConnectorOptions = { maxAttempts: 8, baseDelayMs: 5_000, maxDelayMs: 900_000, timeoutMs: 120_000 };

// ── reads: the sync ──────────────────────────────────────────────────────────

export interface A3docSyncResult {
  scopeId: string;
  /** Changes landed by this call. */
  changes: number;
  full: boolean;
  /** Pages of documents this call read. */
  pages: number;
  /** False when the call stopped at a budget; the next call resumes where it stopped. */
  complete: boolean;
  /** Set when the binding was unbound or bound again while this call ran; it stopped without writing it back. */
  superseded?: true;
}

/**
 * Sync ONE bound scope: folders from the tree, then documents newest-modified first, landing each
 * change through the binding's operation and saving where the next page starts.
 *
 * Landing is **at least once**, keyed by `itemId`: a change is landed, then its bytes, then the
 * item state that says so, and a failure between those steps lands the change again next call.
 */
export async function syncA3docScope(
  host: ScopeHost,
  connectionId: ConnectionId,
  binding: A3docBinding,
  options: A3docOptions & { maxPages?: number; maxVerify?: number; pageSize?: number },
): Promise<A3docSyncResult> {
  const timed = { ...options, timeoutMs: options.timeoutMs ?? SYNC_TIMEOUT_MS };
  const conn = await openA3docConnection(host.admin, timed, { id: connectionId, tenantId: binding.tenantId, vertical: binding.vertical });
  return syncFiles(host, connectionId, binding, options, conn.client);
}

/** One sync engine for both execution models; it never opens a credential itself. */
async function syncFiles(
  host: {
    admin: A3docState;
    getConnectorScope(...args: Parameters<ScopeHost['getConnectorScope']>): Promise<Pick<Awaited<ReturnType<ScopeHost['getConnectorScope']>>, 'invoke'>>;
    getConnectorAttachments(...args: Parameters<ScopeHost['getConnectorAttachments']>): Promise<Pick<Awaited<ReturnType<ScopeHost['getConnectorAttachments']>>, 'upload'>>;
  },
  connectionId: ConnectionId,
  binding: A3docBinding,
  options: A3docOptions & { maxPages?: number; maxVerify?: number; pageSize?: number },
  client: A3docClient,
): Promise<A3docSyncResult> {
  if (binding.folderMissing) throw folderMissingError();
  const now = nowOf(options);

  /** Write the binding back onto what is stored NOW, and only while it is still this binding. */
  const save = async (patch: Partial<A3docBinding>, opts: { endPass?: boolean } = {}) => {
    const stored = await readBinding(host, connectionId, binding.scopeId);
    if (!stored || stored.boundAt !== binding.boundAt || stored.containerId !== binding.containerId) return false;
    const next: A3docBinding = { ...stored, ...patch };
    if (opts.endPass) delete next.pass;
    await host.admin.putConnectorState(connectionId, bindingKey(binding.scopeId), next);
    return true;
  };

  // The folder first: gone from the tree marks the binding and stops, never a fall back to the root.
  const tree = await client.containersTree();
  const bound = findContainer(tree, binding.containerId);
  if (!bound) {
    await save({ folderMissing: { since: now.toISOString() } });
    throw folderMissingError();
  }

  const prefix = itemPrefix(binding);
  const index = await readItems(host, connectionId, binding);
  const itemsByDocument = new Map<string, Set<string>>();
  const namesByContainer = new Map<number, Map<string, Set<string>>>();
  /** Keep document placements and occupied file names aligned with the held-item index. */
  const indexFile = (id: string, entry: ItemEntry, add: boolean) => {
    if (entry.kind !== 'file') return;
    if (entry.documentId) {
      let ids = itemsByDocument.get(entry.documentId);
      if (add && !ids) itemsByDocument.set(entry.documentId, (ids = new Set()));
      if (add) ids!.add(id);
      else if (ids) {
        ids.delete(id);
        if (!ids.size) itemsByDocument.delete(entry.documentId);
      }
    }
    let names = namesByContainer.get(entry.parentId);
    if (add && !names) namesByContainer.set(entry.parentId, (names = new Map()));
    let ids = names?.get(entry.name);
    if (add && !ids) names!.set(entry.name, (ids = new Set()));
    if (add) ids!.add(id);
    else if (ids) {
      ids.delete(id);
      if (!ids.size) names!.delete(entry.name);
      if (!names!.size) namesByContainer.delete(entry.parentId);
    }
  };
  for (const [id, entry] of index) indexFile(id, entry, true);
  const due = !binding.highWater || !binding.lastFull || now.getTime() - Date.parse(binding.lastFull) >= FULL_PASS_EVERY_MS;
  let pass: SyncPass = binding.pass ?? { id: crypto.randomUUID(), full: due, page: 0, startedAt: now.toISOString(), changes: 0 };

  const scopeRef = scopeIdSchema.parse(binding.scopeId);
  const scope = await host.getConnectorScope(connectionId, scopeRef);
  let attachments: Pick<Awaited<ReturnType<ScopeHost['getConnectorAttachments']>>, 'upload'> | undefined;
  const put = async (id: string, entry: ItemEntry | null) => {
    await host.admin.putConnectorState(connectionId, `${prefix}${id}`, entry);
    const prior = index.get(id);
    if (prior) indexFile(id, prior, false);
    if (entry) {
      index.set(id, entry);
      indexFile(id, entry, true);
    } else index.delete(id);
  };
  const invoke = (change: FileSourceChange) => scope.invoke(binding.operation, fileSourceChange.parse(change));
  let changes = 0;

  const landDelete = async (id: string, prior: ItemEntry, reason: 'deleted' | 'moved-out') => {
    await invoke({ change: 'delete', connectionId, itemId: id, kind: prior.kind, path: prior.path, name: prior.name, reason });
    await put(id, null);
    changes++;
  };

  // ── folders ──
  const folderPath = new Map<number, string>([[binding.containerId, '']]);
  const walkFolders = async (parentId: number, parentPath: string, nodes: A3Container[] | null | undefined) => {
    const siblings = [...index.values()].filter((e) => e.kind === 'folder' && e.parentId === parentId);
    for (const node of nodes ?? []) {
      const id = `c${node.id}`;
      const prior = index.get(id);
      let name = prior && prior.source === node.name && prior.parentId === parentId ? prior.name : segment(node.name, String(node.id));
      if ((!prior || prior.name !== name) && siblings.some((s) => s.name === name && s !== prior)) name = `${name} (${node.id})`;
      const path = join(parentPath, name);
      folderPath.set(node.id, path);
      if (!prior || prior.path !== path) {
        await invoke({
          change: 'upsert',
          connectionId,
          itemId: id,
          kind: 'folder',
          path,
          name,
          previousPath: prior && prior.path !== path ? prior.path : null,
          size: null,
          contentType: null,
          lastModifiedAt: null,
          webUrl: null,
          content: null,
        });
        changes++;
      }
      const entry: ItemEntry = { kind: 'folder', parentId, path, name, source: node.name, attachmentId: null, seenIn: pass.id };
      siblings.push(entry);
      await put(id, entry);
      await walkFolders(node.id, path, node.children);
    }
  };
  await walkFolders(binding.containerId, '', bound.children);

  // ── documents ──
  const landDoc = async (doc: A3Document, containerId: number) => {
    const id = `${doc.Id}@${containerId}`;
    const prior = index.get(id);
    const dir = folderPath.get(containerId)!;
    const source = sourceOf(doc);
    let name: string;
    if (prior && prior.source === source && prior.parentId === containerId) {
      name = prior.name;
    } else {
      const requested = (await host.admin.getConnectorState(connectionId, requestedKey(binding.scopeId, doc.Id))) as { name?: string } | undefined;
      name = requested?.name ?? fileNameOf(doc);
      const baseName = name;
      let attempt = 0;
      while (true) {
        const occupants = namesByContainer.get(containerId)?.get(name);
        if (!occupants || (occupants.size === 1 && occupants.has(id))) break;
        const suffix = String(doc.Code ?? doc.Id);
        name = withSuffix(baseName, attempt++ === 0 ? suffix : `${suffix}-${attempt}`);
      }
    }
    const path = join(dir, name);
    const tooLarge = doc.Size == null || doc.Size * 1024 > FILE_SOURCE_MAX_FILE_BYTES;
    let bytes: Uint8Array | null = null;
    let contentChanged =
      !prior || prior.dateModified !== doc.DateModified || prior.size !== doc.Size || (!prior.attachmentId && !prior.tooLarge);
    // A wall-clock time that happened twice cannot tell two edits apart: compare the bytes instead.
    if (!contentChanged && pass.full && prior?.ambiguous && !tooLarge) {
      bytes = await client.download(doc.Id);
      if (bytes && (await sha256Hex(bytes)) !== prior.sha256) contentChanged = true;
    }
    if (prior && prior.path === path && !contentChanged && !!prior.tooLarge === tooLarge) {
      await put(id, { ...prior, seenIn: pass.id });
      return;
    }
    const content = tooLarge ? 'too-large' : contentChanged ? 'follows' : 'unchanged';
    const answer = await invoke({
      change: 'upsert',
      connectionId,
      itemId: id,
      kind: 'file',
      path,
      name,
      previousPath: prior && prior.path !== path ? prior.path : null,
      size: doc.Size != null ? doc.Size * 1024 : null,
      contentType: contentTypeOf(extOf(doc)),
      lastModifiedAt: parseA3Date(doc.DateModified) ?? null,
      webUrl: null,
      content,
    });
    changes++;
    const entry: ItemEntry = {
      kind: 'file',
      parentId: containerId,
      path,
      name,
      source,
      documentId: doc.Id,
      title: doc.Title ?? '',
      ...(doc.Code !== undefined ? { code: doc.Code } : {}),
      ...(doc.DateModified !== undefined ? { dateModified: doc.DateModified } : {}),
      ...(doc.Size !== undefined ? { size: doc.Size } : {}),
      attachmentId: prior?.attachmentId ?? null,
      sha256: prior?.sha256 ?? null,
      tooLarge,
      ambiguous: isAmbiguousA3Date(doc.DateModified),
      seenIn: pass.id,
    };
    if (content === 'follows') {
      const target = fileSourceUpsertAnswer.safeParse(answer);
      if (target.success && target.data.entity) {
        bytes ??= await client.download(doc.Id);
        // Gone between the listing and the download: the next pass answers about it.
        if (bytes) {
          attachments ??= await host.getConnectorAttachments(connectionId, scopeRef);
          const record = await attachments.upload({
            entity: target.data.entity,
            filename: name,
            contentType: contentTypeOf(extOf(doc)) ?? 'application/octet-stream',
            visibility: 'internal',
            body: connectorUploadBody(bytes),
          });
          await invoke({ change: 'content', connectionId, itemId: id, kind: 'file', path, name, attachment: record, replaces: entry.attachmentId });
          entry.attachmentId = record.id;
          entry.sha256 = record.sha256;
        }
      }
    }
    await put(id, entry);
  };

  const pageBudget = options.maxPages ?? SYNC_PAGES_PER_CALL;
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const floor = !pass.full && binding.highWater ? Date.parse(binding.highWater) - OVERLAP_MS : null;
  let pages = 0;
  let listed = pass.verify !== undefined;
  while (!listed && pages < pageBudget) {
    const { documents } = await client.listDocuments({ containerId: binding.containerId, children: true, pageIndex: pass.page, pageSize });
    pages++;
    let reachedFloor = false;
    for (const doc of documents) {
      const modified = parseA3Date(doc.DateModified);
      if (floor !== null && modified && Date.parse(modified) < floor) {
        reachedFloor = true;
        break;
      }
      if (modified && (!pass.highWater || modified > pass.highWater)) pass.highWater = modified;
      const placements = (doc.ContainersId ?? [binding.containerId]).filter((c) => folderPath.has(c));
      for (const c of placements) await landDoc(doc, c);
      // A placement held for this document that its own record no longer lists has moved out.
      if (doc.ContainersId !== undefined) {
        for (const id of [...(itemsByDocument.get(doc.Id) ?? [])]) {
          const e = index.get(id)!;
          if (!placements.includes(e.parentId)) await landDelete(id, e, 'moved-out');
        }
      }
    }
    pass.page++;
    listed = reachedFloor || documents.length < pageSize;
    if (listed && pass.full) {
      pass.verify = [...index.entries()].filter(([, e]) => e.kind === 'file' && e.seenIn !== pass.id).map(([id]) => id);
    }
    pass.changes += changes;
    changes = 0;
    if (!(await save({ pass }))) return { scopeId: binding.scopeId, changes: pass.changes, full: pass.full, pages, complete: false, superseded: true };
  }
  if (!listed) return { scopeId: binding.scopeId, changes: pass.changes, full: pass.full, pages, complete: false };

  // ── held items a full pass never presented: each checked on its own ──
  const verifyBudget = options.maxVerify ?? SYNC_VERIFY_PER_CALL;
  const queue = pass.verify ?? [];
  let checked = 0;
  while (queue.length && checked < verifyBudget) {
    const id = queue.shift()!;
    const e = index.get(id);
    checked++;
    if (!e || e.kind !== 'file' || !e.documentId) continue;
    const here = await client.findByTitle({ containerId: e.parentId, children: false, title: e.title ?? '' });
    if (here.some((d) => d.Id === e.documentId)) continue;
    await landDelete(id, e, (await client.download(e.documentId)) ? 'moved-out' : 'deleted');
  }
  pass.changes += changes;
  if (queue.length) {
    pass.verify = queue;
    await save({ pass });
    return { scopeId: binding.scopeId, changes: pass.changes, full: pass.full, pages, complete: false };
  }

  const done: Partial<A3docBinding> = {
    lastSync: { syncedAt: nowOf(options).toISOString(), changes: pass.changes },
    ...(pass.highWater && (!binding.highWater || pass.highWater > binding.highWater) ? { highWater: pass.highWater } : {}),
    ...(pass.full ? { lastFull: pass.startedAt } : {}),
  };
  if (!(await save(done, { endPass: true }))) return { scopeId: binding.scopeId, changes: pass.changes, full: pass.full, pages, complete: false, superseded: true };
  return { scopeId: binding.scopeId, changes: pass.changes, full: pass.full, pages, complete: true };
}

function findContainer(tree: A3Container[], id: number): A3Container | null {
  if (id === A3DOC_ROOT_CONTAINER) return tree.find((c) => c.id === id) ?? { id, name: '', children: tree };
  for (const node of tree) {
    if (node.id === id) return node;
    const hit = findContainer(node.children ?? [], id);
    if (hit) return hit;
  }
  return null;
}

/**
 * A hosted dispatch uses a scope operation for its write journal: call-state writes are committed
 * only on success, but an upload attempt must survive a lost provider answer and a failed call.
 */
export async function dispatchA3docContext(ctx: ScopedConnectionContext, event: DomainEvent, options: A3docOptions, journalOperation: string): Promise<void> {
  const binding = contextBinding(ctx, options);
  const admin = contextState(ctx);
  const durable: A3docState = {
    ...admin,
    getConnectorState: async (id, key) => key === bindingKey(ctx.scope.scopeId) ? binding : key.startsWith(`${KEY}write:`)
      ? (await ctx.invoke<{ value: unknown }>(journalOperation, { key })).value : admin.getConnectorState(id, key),
    putConnectorState: async (id, key, value) => {
      if (key.startsWith(`${KEY}write:`)) await ctx.invoke(journalOperation, { key, value });
      else await admin.putConnectorState(id, key, value);
    },
  };
  await dispatchFiles({ scopeId: ctx.scope.scopeId, admin: durable,
    connection: async () => ({ id: ctx.connection.id, secret: { ...ctx.secret }, fetch: ctx.fetch,
      openAttachmentStream: async (id) => {
        const opened = await ctx.attachments.open(id);
        if (!opened) return null;
        return { record: opened.record, contentType: opened.contentType, body: bytesStream(opened.body) };
      },
    }),
  }, event, options);
}

/** Rebuild provider metadata from the platform's binding; no tenant/scope is read from state. */
function contextBinding(ctx: ScopedConnectionContext, options: A3docOptions): A3docBinding {
  const containerId = ctx.scope.options.containerId;
  if (typeof containerId !== 'number' || !Number.isInteger(containerId)) throw new Error('a3doc binding has no resolved container');
  if (!ctx.scope.operation) throw new Error('a3doc binding has no landing operation');
  return { scopeId: ctx.scope.scopeId, tenantId: ctx.scope.tenantId, vertical: ctx.connection.vertical,
    operation: ctx.scope.operation, permission: '', folder: String(ctx.scope.options.folder ?? ''),
    containerId, boundAt: nowOf(options).toISOString(), canUpload: ctx.scope.options.canUpload === true,
    ...(typeof ctx.scope.options.customerId === 'string' ? { customerId: ctx.scope.options.customerId } : {}),
  };
}

/** Resolve a platform-owned binding, returning only provider options to the platform. */
export async function bindA3docContext(ctx: ScopedConnectionContext, options: A3docOptions): Promise<Record<string, unknown>> {
  const client = clientFor(ctx.fetch, a3docSecret.parse(ctx.secret), options);
  const folder = typeof ctx.scope.options.folder === 'string' ? ctx.scope.options.folder : '';
  const segments = folder.split('/').map((s) => s.trim()).filter(Boolean);
  const container = containerAtPath(await client.containersTree(), segments);
  if (!container) throw substratError('conflict', `no a3doc folder at '${folder}'`);
  const me = await client.userInfo();
  const sample = await client.listDocuments({ containerId: container.id, children: true, pageIndex: 0, pageSize: 1 });
  return { folder: segments.join('/'), containerId: container.id, canUpload: canUploadAs(me.role),
    ...(sample.documents[0]?.CustomerId ? { customerId: sample.documents[0].CustomerId } : {}) };
}

/** Adapt a capability scoped by the platform to the shared state and sync engine. */
export async function syncA3docContext(ctx: ScopedConnectionContext, options: A3docOptions): Promise<A3docSyncResult> {
  const resolved = contextBinding(ctx, options);
  const key = bindingKey(ctx.scope.scopeId);
  const previous = await ctx.state.get(key) as A3docBinding | undefined;
  const binding = previous?.containerId === resolved.containerId ? { ...previous, ...resolved, boundAt: previous.boundAt } : resolved;
  await ctx.state.put(key, binding);
  const admin = contextState(ctx);
  return syncFiles({ admin,
    getConnectorScope: async () => ({ invoke: async <O>(operation: string, input?: unknown) => ctx.invoke<O>(operation, input) }),
    getConnectorAttachments: async () => ({ upload: ctx.attachments.upload }),
  }, ctx.connection.id, binding, { ...options, maxPages: 1, maxVerify: 5, pageSize: 25 }, clientFor(ctx.fetch, a3docSecret.parse(ctx.secret), options));
}

/** Connection ids are already fenced by the platform; state keys stay scope-local. */
function contextState(ctx: ScopedConnectionContext): A3docState {
  return {
    getConnectorState: async (_id, key) => ctx.state.get(key),
    putConnectorState: async (_id, key, value) => ctx.state.put(key, value),
    listConnectorState: async (_id, prefix) => ctx.state.list(prefix),
  };
}

export interface A3docSweepResult {
  found: number;
  synced: A3docSyncResult[];
  failed: { scopeId: string; error: string }[];
}

/** Sync every scope bound on a connection. One scope failing never stops another. */
export async function sweepA3docFiles(host: ScopeHost, connectionId: ConnectionId, options: A3docOptions): Promise<A3docSweepResult> {
  const result: A3docSweepResult = { found: 0, synced: [], failed: [] };
  for (const binding of await listA3docBindings(host, connectionId)) {
    result.found += 1;
    try {
      result.synced.push(await syncA3docScope(host, connectionId, binding, options));
    } catch (err) {
      result.failed.push({ scopeId: binding.scopeId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

// ── bytes ────────────────────────────────────────────────────────────────────

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  txt: 'text/plain',
  xml: 'application/xml',
  csv: 'text/csv',
  eml: 'message/rfc822',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
};
const contentTypeOf = (ext: string) => CONTENT_TYPES[ext] ?? null;

/** A sized stream, read whole: a3doc takes a document as one base64 string, so it is held anyway. */
async function bytesOf(body: SizedByteStream): Promise<Uint8Array> {
  const out = new Uint8Array(body.length);
  let at = 0;
  const reader = body.stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done || !next.value) break;
    out.set(next.value, at);
    at += next.value.byteLength;
  }
  if (at !== body.length) throw new Error(`attachment stream was ${at} bytes, not the ${body.length} it declared`);
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
