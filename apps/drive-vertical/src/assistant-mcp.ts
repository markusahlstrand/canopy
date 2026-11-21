/**
 * The drive's MCP endpoint (`/api/mcp`) as an assistant (Claude Desktop, …) needs it: every space
 * the login can enter, and the install's flows (#418).
 *
 * The platform derives one tool per drive operation and sends every call to ONE scope: the space
 * the request names (`x-site`, `?site=`), else the install's home space. An MCP client names
 * neither, so each call landed in the home space, which usually has no source and no plugins,
 * and flows (kept by the install, not by any space) were not tools at all.
 *
 * So one connection here is bound to no space. This mount renders the same drive operations plus:
 *  - a REQUIRED `space` argument on every drive tool: the slug of the space to act in, resolved
 *    per call to the caller's principal there. A space they are not a member of is refused before
 *    any scope is reached, and inside one they hold exactly the permissions they hold in the app;
 *  - `drive_list-spaces` and `drive_list-space-folders`, to find those slugs and the folder ids a
 *    flow copies into;
 *  - flow tools that call the app's own flow routes (`flow-routes.ts`) in-process, so an assistant
 *    meets exactly the checks the app does: `flowSaveInput`, owning every space a flow names,
 *    being able to add files to each folder it copies into.
 *
 * Nothing here grants anything: a tool call reaches what the same login could reach in the app.
 */
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from '@substrat-run/contracts';
import { mountMcp } from '@substrat-run/vertical-host';
import type { ScopeStub } from '@substrat-run/kernel';
import { deliveryState, segment } from '@canopy/scope-drive/spec/model';
import { DECIDE_BATCH_LIMIT, flowSaveInput } from './flow-contract.js';
import {
  checkedUpload, decodeBase64, MAX_ALSO_IN, MAX_INLINE_UPLOAD_BYTES, mintUploadToken, UPLOAD_TYPES,
  uploadPreflight, uploadResult, uploadToFolder, uploadTokenHash, uploadTypeOf, type UploadLink, type UploadTarget,
} from './upload.js';
import { MAX_UPLOAD_BYTES } from './upload-limit.js';

/** The argument every space-scoped drive tool takes. */
export const SPACE_ARG = 'space';

/** The top folder of every space. */
export const ROOT_FOLDER_ID = 'root';

/** What a stub in a space needs to do for this mount. */
export interface SpaceInvoker {
  invoke<T = unknown>(operation: string, input?: unknown, options?: unknown): Promise<T>;
}

export interface SpaceCategory { id: string; name: string; hint?: string }

/** A space this login can enter, as the caller there. */
export interface AssistantSite {
  slug: string;
  name: string;
  categories: SpaceCategory[];
  scope: SpaceInvoker;
}

/** What one MCP request reaches, for the caller who made it. */
export interface AssistantAccess {
  /** Every space this login is a member of. */
  sites(): Promise<AssistantSite[]>;
  /** The caller in a space by slug, or null unless it is a space they are a member of. */
  scopeFor(slug: string): Promise<SpaceInvoker | null>;
  /** The app's flow routes (`/api/flows…`), called as this caller. */
  flows(method: string, path: string, body?: unknown): Promise<Response>;
  /** Where the caller's bytes go in a space by slug, as its principal there; null unless a member. */
  uploadTarget(slug: string): Promise<UploadTarget | null>;
  /** Keep an upload link for the caller in a space (its token hashed); null unless a member. */
  saveUploadLink(slug: string, link: Omit<UploadLink, 'sub' | 'scopeId' | 'expiresAt'> & { tokenHash: string }): Promise<{ ok: true; expiresAt: number } | { error: 'limit' } | null>;
  /** This install's origin, for the links it hands out. */
  origin: string;
}

/** What the install knows, as `assistantAccess` asks it: the tenant's registry and directory. */
export interface AssistantDirectory {
  /** The tenant's spaces, member or not. */
  listSites(): Promise<{ slug: string; name: string; scopeId: string }[]>;
  /** A slug's scope in this tenant, or null. */
  resolveSiteScope(slug: string): Promise<string | null>;
  /** The principal a login is bound to in a space, or null when it is not a member there. */
  principalIn(scopeId: string, sub: string): Promise<string | null>;
  /** A space's settings: its name as people renamed it, and its categories. */
  settings(scopeId: string): Promise<{ name?: string; categories?: SpaceCategory[] } | null>;
  /** The space's stub as that principal. May refuse (a deleted or inactive space). */
  scopeAs(principal: string, scopeId: string): Promise<SpaceInvoker>;
  /** Storing bytes in a space as that principal, and what runs after a write there. */
  uploadsAs(principal: string, scopeId: string): Promise<Omit<UploadTarget, 'scope'>>;
  /** Keep an upload link (only its token's hash); the store's clock says when it expires. */
  saveUploadLink(link: Omit<UploadLink, 'expiresAt'> & { tokenHash: string }): Promise<{ ok: true; expiresAt: number } | { error: 'limit' }>;
}

/**
 * What a login reaches over MCP: the spaces it is BOUND in, each as its principal there, and
 * nothing else. Membership is asked per space on every call, so an unbound login never gets a stub
 * for a space, whatever slug it names; inside a space the kernel checks each operation as usual.
 */
export function assistantAccess(
  directory: AssistantDirectory,
  sub: string,
  flows: AssistantAccess['flows'],
  origin = '',
): AssistantAccess {
  const member = async (scopeId: string): Promise<{ principal: string; scope: SpaceInvoker } | null> => {
    const principal = await directory.principalIn(scopeId, sub);
    if (!principal) return null;
    const scope = await directory.scopeAs(principal, scopeId).catch(() => null);
    return scope ? { principal, scope } : null;
  };
  const asMember = async (scopeId: string) => (await member(scopeId))?.scope ?? null;
  const memberBySlug = async (slug: string) => {
    const scopeId = await directory.resolveSiteScope(slug);
    const found = scopeId ? await member(scopeId) : null;
    return found && scopeId ? { ...found, scopeId } : null;
  };
  return {
    sites: async () => {
      const all = await Promise.all((await directory.listSites()).map(async (site) => {
        const scope = await asMember(site.scopeId);
        if (!scope) return null;
        const settings = await directory.settings(site.scopeId).catch(() => null);
        const categories = (settings?.categories ?? []).map(({ id, name, hint }) => ({ id, name, ...(hint ? { hint } : {}) }));
        return { slug: site.slug, name: settings?.name ?? site.name, categories, scope };
      }));
      return all.filter((site): site is AssistantSite => site !== null);
    },
    scopeFor: async (slug) => {
      const scopeId = await directory.resolveSiteScope(slug);
      return scopeId ? asMember(scopeId) : null;
    },
    flows,
    uploadTarget: async (slug) => {
      const found = await memberBySlug(slug);
      return found ? { scope: found.scope, ...(await directory.uploadsAs(found.principal, found.scopeId)) } : null;
    },
    saveUploadLink: async (slug, link) => {
      const found = await memberBySlug(slug);
      return found ? directory.saveUploadLink({ ...link, sub, scopeId: found.scopeId }) : null;
    },
    origin,
  };
}

/** The shape this mount reads off a declared operation. */
interface Declared {
  readonly input?: unknown;
  readonly paged?: unknown;
  readonly http?: { readonly method: string; readonly path: string };
  readonly summary?: string;
  readonly mcp?: false | { readonly description?: string };
  readonly [key: string]: unknown;
}

const spaceField = z.string().min(1).max(64).describe('The space to act in: a slug from drive_list-spaces.');

const FOLDER_LIMIT_MAX = 2_000;

const listSpaceFoldersInput = z.object({
  space: z.string().min(1).max(64).describe('The space whose folders to list: a slug from drive_list-spaces.'),
  limit: z.number().int().min(1).max(FOLDER_LIMIT_MAX).optional().describe(`How many folders at most (default 500, at most ${FOLDER_LIMIT_MAX}).`),
});
const flowIdInput = z.object({ id: z.string().min(1).max(64).describe('The flow id, from drive_list-flows.') });
const previewFlowInput = flowSaveInput.pick({ id: true, graph: true });
const deliveriesInput = z.object({
  flowId: z.string().min(1).max(64).optional().describe('Only this flow\'s deliveries.'),
  state: deliveryState.optional().describe('Only deliveries in this state. "proposed" ones wait for approval.'),
  limit: z.number().int().min(1).max(200).optional().describe('How many, newest first (default 50).'),
});
const decideInput = z.object({
  space: z.string().min(1).max(64).describe('The delivery\'s `space`, as drive_list-flow-deliveries returned it.'),
  flowId: z.string().min(1).max(64),
  fileId: z.string().min(1),
  versionId: z.string().min(1),
  decision: z.enum(['approve', 'dismiss', 'retry']).describe('approve or dismiss a proposed delivery; retry a failed one.'),
});

const uploadPlace = {
  space: z.string().min(1).max(64).describe('The space to file it in: a slug from drive_list-spaces.'),
  folderId: z.string().min(1).max(64).describe('The folder to put it in: an id from drive_list-space-folders ("root" is the top level).'),
  name: segment.describe('The file name, with its extension: it decides the type (pdf, png, jpg, docx, xlsx, csv, xml, xsig…).'),
  alsoIn: z.array(z.string().min(1).max(64)).max(MAX_ALSO_IN).optional()
    .describe('a3doc spaces only: up to 10 more folder ids (from drive_list-space-folders) to file the document under as a3doc categories too.'),
};
const uploadFileInput = z.object({
  ...uploadPlace,
  contentBase64: z.string().min(1).describe(`The file's bytes, base64. At most ${MAX_INLINE_UPLOAD_BYTES / 1024 / 1024} MB.`),
});
const uploadLinkInput = z.object(uploadPlace);

const UPLOAD_RULES = [
  'Who: only someone who may add files to that folder (an owner or editor of the space); a viewer is refused.',
  'If the folder already has a file with that name, nothing is written and the existing file comes back (`created: false`): an a3doc document cannot be deleted, so a retry never files it twice. Pick another name for a new document.',
  'A Qonto space mirrors the bank account and takes no uploads. In an a3doc space the document is sent on to a3doc (`source.sent`), filed in the folder plus every `alsoIn` category.',
  `Accepted types, by the name's extension: ${Object.keys(UPLOAD_TYPES).join(', ')}. The bytes must match the type.`,
  'Existing flows treat it like any upload: it "arrived" in that space.',
].join(' ');

const FLOW_GRAPH_GUIDE = [
  'A flow belongs to the install, not to a space: its trigger watches one or more spaces and its copy steps may write into others.',
  'It acts as the login that saved it last, so it can never do more than you could by hand.',
  'You may only save a flow if you own every space it names (role "owner" in drive_list-spaces); a flow is only listed to someone who owns all its spaces.',
  '',
  'graph = { nodes, edges, versions }. `versions`: "first" acts on a document once, "every" again for each new version.',
  'Nodes (each needs a unique `id` of letters, digits, - or _; `position` is optional and only for the app\'s canvas):',
  '- trigger (exactly one): { type: "trigger", on: "arrived" | "classified" | "schedule", every?: "hour"|"day"|"week"|"month" (schedule only), spaces: [space slugs] }.',
  '  "arrived" = a version was uploaded, synced or mailed in; "classified" = Document AI or a person set its category; "schedule" = periodically over what arrived since the last run.',
  '- check: { type: "check", condition } with a Yes and a No exit. condition.field is one of:',
  '  folder { op: "is" | "under", path: "Bank/2026" ("" is the top level) }, name { op: "contains" | "matches", value (matches takes * and ?) },',
  '  extension { values: ["pdf"] }, category { values: [category ids from drive_list-spaces], minConfidence?: 0..1 },',
  '  label { value }, ask { question } (a yes/no question the model answers about the document; costs a model call per document).',
  '- approval: { type: "approval" }: the run waits for a person to approve. At most one on any path.',
  '- copy: { type: "copy", space, folderId, alsoIn: [] }: copy the document into a folder of a space (folder ids from drive_list-space-folders, "root" is the top level).',
  '  `alsoIn` files an a3doc document in more categories (more folder ids of that space). A copy into an a3doc space cannot be deleted there, so put an approval before it.',
  '  The input schema lists every copy field this install supports.',
  '- label: { type: "label", value }: add a label to the document where it is.',
  'Edges: { from, to, branch }. A check leads on by branch "yes" and/or "no"; every other node by one "next" edge.',
  'The graph must be acyclic, every node reachable from the trigger, and hold at least one action (copy or label).',
  '',
  'Example: { "nodes": [ { "id": "t", "type": "trigger", "on": "arrived", "spaces": ["bank"] },',
  ' { "id": "pdf", "type": "check", "condition": { "field": "extension", "values": ["pdf"] } },',
  ' { "id": "ok", "type": "approval" }, { "id": "copy", "type": "copy", "space": "accountant", "folderId": "<id>", "alsoIn": [] } ],',
  ' "edges": [ { "from": "t", "to": "pdf", "branch": "next" }, { "from": "pdf", "to": "ok", "branch": "yes" }, { "from": "ok", "to": "copy", "branch": "next" } ],',
  ' "versions": "first" }',
].join('\n');

/** One delivery, or several in `items`: the app's decide route takes either, by the same checks. */
const decideManyInput = decideInput.partial().extend({
  items: z.array(decideInput).min(1).max(DECIDE_BATCH_LIMIT).optional()
    .describe(`Several decisions at once, at most ${DECIDE_BATCH_LIMIT} per call; leave the single fields out. Answers { results } in the same order.`),
});

/**
 * The tools this mount adds. Declarations in the platform's shape, so `mountMcp` renders them like
 * any operation; `http` only marks them as tools and says read or write: no route is mounted.
 */
export const assistantOperations = {
  'drive/list-spaces': {
    summary: 'List the spaces you can open',
    mcp: { description: [
      'List every Canopy space you are a member of: its slug and name; your role there (owner, editor or viewer: only an owner may use a space in a flow);',
      'its kind (storage, or the source it mirrors: a3doc, qonto, …) and `source` (provider, canUpload); `readOnly` when nothing can be uploaded there (a read-only source, or you are a viewer);',
      'and its categories (the ids a flow\'s category check matches on).',
      `Every other drive tool acts in one space: pass its slug as \`${SPACE_ARG}\`. One connection reaches all of them, each with the permissions you have in the app.`,
    ].join(' ') },
    http: { method: 'GET', path: '/spaces' },
  },
  'drive/list-space-folders': {
    summary: 'List every folder of a space by path',
    mcp: { description: 'Every folder of a space as { id, path }, the top level first as { id: "root", path: "" }. Use it to find the folder id a flow\'s copy step needs, or the path a folder check matches on.' },
    input: listSpaceFoldersInput,
    http: { method: 'GET', path: '/spaces/{space}/folders' },
  },
  'drive/list-flows': {
    summary: 'List flows',
    mcp: { description: 'List the install\'s flows you can see (those all of whose spaces you own), each with its graph, whether it is on, failures and the spaces it watches or writes; plus `spaces`: the spaces you own, which a flow you save may use (a3doc: true means what arrives there goes on to a3doc and cannot be deleted).' },
    http: { method: 'GET', path: '/flows' },
  },
  'drive/get-flow': {
    summary: 'Read one flow',
    mcp: { description: 'Read one flow by id: its name, whether it is on, its graph and the spaces it touches. Read it before changing it: drive_save-flow replaces the whole flow.' },
    input: flowIdInput,
    http: { method: 'GET', path: '/flows/{id}' },
  },
  'drive/save-flow': {
    summary: 'Create or update a flow',
    mcp: { description: [
      'Create a flow (omit `id`) or replace an existing one (pass its `id`; send the whole flow, read it first with drive_get-flow).',
      '`enabled: false` saves it switched off. Saving is checked exactly as in the app; a refusal says what to fix.',
      'Try drive_preview-flow first to see which documents it would act on.',
      '',
      FLOW_GRAPH_GUIDE,
    ].join('\n') },
    input: flowSaveInput,
    http: { method: 'PUT', path: '/flows' },
  },
  'drive/remove-flow': {
    summary: 'Delete a flow',
    mcp: { description: 'Delete a flow by id, with its history. What it already copied stays where it is.' },
    input: flowIdInput,
    http: { method: 'DELETE', path: '/flows/{id}' },
  },
  'drive/preview-flow': {
    summary: 'Preview which documents a flow would act on',
    mcp: { description: 'Which documents already in the watched spaces a flow (saved or not: pass its graph, and its id to mark documents it already handled) would reach an action for, and how many reach each step (`reach` and `maybe`, by node id). Never calls a model: a document whose path depends on an "ask" check counts as uncertain. Changes nothing.' },
    input: previewFlowInput,
    http: { method: 'POST', path: '/flows/preview' },
  },
  'drive/run-flow': {
    summary: 'Run a flow over the documents already there',
    mcp: { description: 'Run a saved, switched-on flow now over the documents already in each space it watches. Each document it reaches an action for is acted on (or proposed, at an approval step) once; ones it already handled are skipped. New documents are handled by the trigger on their own; this is for what was there before.' },
    input: flowIdInput,
    http: { method: 'POST', path: '/flows/{id}/run' },
  },
  'drive/list-flow-deliveries': {
    summary: 'What your flows did',
    mcp: { description: 'What your flows did to documents, newest first, from every space they watch: proposed (waiting for approval), done, failed, skipped… with the path each document took and where copies went.' },
    input: deliveriesInput,
    http: { method: 'GET', path: '/flow-deliveries' },
  },
  'drive/decide-flow-delivery': {
    summary: 'Approve, dismiss or retry a flow delivery',
    mcp: { description: 'Approve or dismiss a delivery a flow proposed (waiting at an approval step), or retry a failed one. Take the fields from drive_list-flow-deliveries. To decide many (say every proposal of a flow), pass them in `items`: each is decided on its own, approved once even if named twice, and each result says ok with its new state, or why it was refused; what succeeded stays done.' },
    input: decideManyInput,
    http: { method: 'POST', path: '/flow-deliveries/decide' },
  },
  'drive/upload-file': {
    summary: 'Upload a file into a folder of a space',
    mcp: { description: [
      `Upload a small file (at most ${MAX_INLINE_UPLOAD_BYTES / 1024 / 1024} MB) whose bytes you have, as base64.`,
      'Base64 costs about one token per 3 characters, so anything past roughly 100 KB is far cheaper through drive_create-upload-link, which never passes the bytes through you.',
      UPLOAD_RULES,
    ].join(' ') },
    input: uploadFileInput,
    http: { method: 'POST', path: '/uploads' },
  },
  'drive/create-upload-link': {
    summary: 'Get a one-time link to upload a file',
    mcp: { description: [
      `A link to upload one file (up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB) into a folder, under the name given here: PUT the raw bytes to it, e.g.`,
      '`curl -X PUT -H "content-type: application/pdf" --data-binary @invoice.pdf "<url>"`. It works once and for 10 minutes, and answers like drive_upload-file.',
      'Use it whenever you (or a tool you can run) can read the file from disk.',
      UPLOAD_RULES,
    ].join(' ') },
    input: uploadLinkInput,
    http: { method: 'POST', path: '/upload-links' },
  },
} as const satisfies Record<string, Declared>;

type AssistantOperation = keyof typeof assistantOperations;
const isAssistantOperation = (name: string): name is AssistantOperation => Object.hasOwn(assistantOperations, name);

/**
 * The drive's operations as tools that take `space` (required). An operation whose input cannot
 * take one (not an object) is left out of MCP rather than sent to a space nobody named.
 */
export function withSpaceArg(operations: Readonly<Record<string, object>>): Record<string, object> {
  const out: Record<string, object> = {};
  for (const [name, op] of Object.entries(operations) as [string, Declared][]) {
    if (!op.http || op.mcp === false) { out[name] = op; continue; }
    const input = op.input as { safeExtend?: (shape: object) => unknown; _zod?: unknown } | undefined;
    if (input === undefined) { out[name] = { ...op, input: z.object({ [SPACE_ARG]: spaceField }) }; continue; }
    let extended: unknown;
    try {
      extended = input._zod && typeof input.safeExtend === 'function' ? input.safeExtend({ [SPACE_ARG]: spaceField }) : undefined;
    } catch {
      extended = undefined;
    }
    out[name] = extended ? { ...op, input: extended } : { ...op, mcp: false };
  }
  return out;
}

/** The whole catalog this endpoint renders: the drive's tools with `space`, and the assistant's. */
export function assistantCatalog(driveOperations: Readonly<Record<string, object>>): Record<string, object> {
  for (const name of Object.keys(assistantOperations)) {
    if (Object.hasOwn(driveOperations, name)) throw new Error(`assistant MCP: '${name}' is already a drive operation`);
  }
  return { ...withSpaceArg(driveOperations), ...assistantOperations };
}

const notThere = (slug: string) =>
  new HTTPException(404, { message: `There is no space '${slug}' that you can open. drive_list-spaces lists yours.` });

/** A flow route's answer, or its refusal as an error the MCP mount turns into a tool error (401 stays a 401). */
async function answered<T>(res: Response): Promise<T> {
  if (res.ok) return (res.status === 204 ? null : await res.json()) as T;
  const text = await res.text();
  let message = text;
  try {
    const body = JSON.parse(text) as { detail?: unknown; message?: unknown; error?: unknown; title?: unknown };
    const said = [body.detail, body.message, body.error, body.title].find((v) => typeof v === 'string' && v);
    if (typeof said === 'string') message = said;
  } catch { /* plain text */ }
  throw new HTTPException(res.status as 400, { message: message || `The request failed (${res.status}).` });
}

/** Every folder of a space, breadth first, by path: what a copy step can name. */
async function foldersOf(scope: SpaceInvoker, limit: number) {
  const folders: { id: string; path: string }[] = [{ id: ROOT_FOLDER_ID, path: '' }];
  const queue = [...folders];
  let truncated = false;
  while (queue.length) {
    const parent = queue.shift()!;
    let cursor: string | undefined;
    do {
      const page = await scope.invoke<{ entries: { id: string; name: string }[]; nextCursor?: string | null }>(
        'drive/list-folders', { folderId: parent.id, limit: 200, ...(cursor ? { cursor } : {}) },
      );
      for (const f of page.entries) {
        if (folders.length >= limit) { truncated = true; break; }
        const folder = { id: f.id, path: parent.path ? `${parent.path}/${f.name}` : f.name };
        folders.push(folder);
        queue.push(folder);
      }
      cursor = truncated ? undefined : page.nextCursor ?? undefined;
    } while (cursor);
    if (truncated) break;
  }
  return { folders: folders.sort((a, b) => a.path.localeCompare(b.path)), truncated };
}

/** Input checked against its schema, a refusal naming what is wrong. */
function parsed<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new HTTPException(400, { message: `${issue?.path.join('.') || 'input'}: ${issue?.message ?? 'invalid'}` });
  }
  return result.data;
}

/** What one assistant tool does. */
async function runAssistant(access: AssistantAccess, operation: AssistantOperation, raw: unknown): Promise<unknown> {
  const input = (raw ?? {}) as Record<string, unknown>;
  switch (operation) {
    case 'drive/list-spaces': {
      const sites = await access.sites();
      return {
        spaces: await Promise.all(sites.map(async (site) => {
          // The role as what the caller may do there: the same checks the app's own screens ask.
          const [people, top, connected] = await Promise.all([
            site.scope.invoke<{ canManage: boolean }>('drive/people-access').catch(() => ({ canManage: false })),
            site.scope.invoke<{ canWrite?: boolean }>('drive/get-folder', { folderId: ROOT_FOLDER_ID }).catch(() => ({ canWrite: false })),
            site.scope.invoke<{ source: { provider: string; canUpload: boolean } | null }>('drive/get-source').catch(() => ({ source: null })),
          ]);
          const role = people.canManage ? 'owner' : top.canWrite ? 'editor' : 'viewer';
          const source = connected.source ? { provider: connected.source.provider, canUpload: connected.source.canUpload } : null;
          return {
            slug: site.slug, name: site.name, role,
            kind: source ? source.provider.replace(/^canopy\./, '') : 'storage',
            source,
            // As the app shows it: a mirror that takes no uploads is read-only, for everyone.
            readOnly: role === 'viewer' || (source !== null && !source.canUpload),
            categories: site.categories,
          };
        })),
      };
    }
    case 'drive/list-space-folders': {
      const { space, limit } = listSpaceFoldersInput.parse(input);
      const scope = await access.scopeFor(space);
      if (!scope) throw notThere(space);
      return { space, ...(await foldersOf(scope, limit ?? 500)) };
    }
    case 'drive/list-flows':
      return answered(await access.flows('GET', '/api/flows'));
    case 'drive/get-flow': {
      const { id } = flowIdInput.parse(input);
      const { flows } = await answered<{ flows: { id: string }[] }>(await access.flows('GET', '/api/flows'));
      const flow = flows.find((f) => f.id === id);
      if (!flow) throw new HTTPException(404, { message: 'Flow not found.' });
      return flow;
    }
    case 'drive/save-flow':
      // Unparsed: the route checks it with `flowSaveInput`, and its refusal says what is missing.
      return answered(await access.flows('PUT', '/api/flows', input));
    case 'drive/remove-flow': {
      const { id } = flowIdInput.parse(input);
      return answered(await access.flows('DELETE', `/api/flows/${encodeURIComponent(id)}`));
    }
    case 'drive/preview-flow':
      return answered(await access.flows('POST', '/api/flows/preview', input));
    case 'drive/run-flow': {
      const { id } = flowIdInput.parse(input);
      return answered(await access.flows('POST', `/api/flows/${encodeURIComponent(id)}/run`, {}));
    }
    case 'drive/list-flow-deliveries': {
      const { flowId, state, limit } = deliveriesInput.parse(input);
      const query = new URLSearchParams({ ...(flowId ? { flowId } : {}), ...(state ? { state } : {}), ...(limit ? { limit: String(limit) } : {}) });
      return answered(await access.flows('GET', `/api/flow-deliveries${query.size ? `?${query}` : ''}`));
    }
    case 'drive/decide-flow-delivery':
      return answered(await access.flows('POST', '/api/flow-deliveries/decide', input));
    case 'drive/upload-file': {
      const { space, folderId, name, contentBase64, alsoIn } = parsed(uploadFileInput, input);
      uploadTypeOf(name);
      // Who may write here, before the bytes are decoded or looked at: a refused caller costs no copy of them.
      const target = await access.uploadTarget(space);
      if (!target) throw notThere(space);
      await uploadPreflight(target.scope, { folderId, alsoIn });
      const bytes = decodeBase64(contentBase64);
      const mime = checkedUpload(name, bytes);
      return uploadResult(await uploadToFolder(target, { folderId, name, mime, body: async () => bytes, alsoIn, existing: 'keep' }));
    }
    case 'drive/create-upload-link': {
      const { space, folderId, name, alsoIn } = parsed(uploadLinkInput, input);
      const mime = uploadTypeOf(name);
      const target = await access.uploadTarget(space);
      if (!target) throw notThere(space);
      await uploadPreflight(target.scope, { folderId, alsoIn });
      const token = mintUploadToken();
      const saved = await access.saveUploadLink(space, { folderId, name, alsoIn: alsoIn ?? [], tokenHash: await uploadTokenHash(token) });
      if (!saved) throw notThere(space);
      if ('error' in saved) throw new HTTPException(429, { message: 'You have too many unused upload links. Use or let some expire (10 minutes) first.' });
      const url = `${access.origin}/api/upload-links/${token}`;
      return {
        url, method: 'PUT', contentType: mime, maxBytes: MAX_UPLOAD_BYTES, expiresAt: new Date(saved.expiresAt).toISOString(),
        example: `curl -X PUT -H "content-type: ${mime}" --data-binary @"${name.replace(/["\\$`]/g, '')}" "${url}"`,
      };
    }
  }
}

/**
 * The stub `mountMcp` invokes: an assistant tool runs here, and a drive tool goes to the space its
 * `space` names (taken out before the operation sees its input), as the caller's principal there.
 */
export function assistantStub(
  access: AssistantAccess,
  driveOperations: Readonly<Record<string, object>>,
  ids: Pick<ScopeStub, 'tenantId' | 'scopeId'>,
): ScopeStub {
  return {
    ...ids,
    invoke: (async (operation: string, input?: unknown, options?: unknown) => {
      if (isAssistantOperation(operation)) return runAssistant(access, operation, input);
      const declared = driveOperations[operation] as Declared | undefined;
      const { [SPACE_ARG]: slug, ...rest } = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
      // No bound space to fall back on: a drive tool always says which space it acts in.
      if (typeof slug !== 'string' || !slug) {
        throw new HTTPException(400, { message: `Say which space to act in: pass \`${SPACE_ARG}\`, a slug from drive_list-spaces.` });
      }
      const scope = await access.scopeFor(slug);
      if (!scope) throw notThere(slug);
      // An operation that declares no input (and is not paged) takes none, as over HTTP.
      return scope.invoke(operation, declared?.input === undefined && !declared?.paged ? undefined : rest, options);
    }) as ScopeStub['invoke'],
  };
}

/** The largest MCP request accepted: an inline upload at its limit, as base64, and room for the rest. */
export const MAX_MCP_BODY_BYTES = 8 * 1024 * 1024;

/**
 * The request as this endpoint authenticates it: its headers without the session cookie.
 *
 * An MCP client signs in with a bearer token, which a browser never attaches on its own. A cookie
 * it does attach, to a cross-site "simple" POST too (`text/plain`, no preflight), so an endpoint
 * that took the cookie could be driven by any page the person visits: saving, running or deleting
 * flows as them, past the JSON-and-same-origin guard the app's own `/api/*` mutations sit behind.
 * Bearer only closes that whatever the origin; forward THESE headers to anything called on the
 * caller's behalf (the flow routes), so the cookie never authenticates a call from here either.
 */
export function bearerOnly(request: Request): Headers {
  const headers = new Headers(request.headers);
  headers.delete('cookie');
  return headers;
}

/**
 * Mount `/api/mcp` with the drive's tools (each taking `space`) and the assistant's. `resolve`
 * authenticates the request by its `bearerOnly` headers (a 401 starts the client's sign-in) and
 * says what the caller reaches. A body that is not `application/json` is refused (415), as the
 * MCP transport sends nothing else.
 */
export function mountAssistantMcp<E extends object>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  driveOperations: Readonly<Record<string, object>>,
  resolve: (c: Context<E>, headers: Headers) => Promise<{ access: AssistantAccess; ids: Pick<ScopeStub, 'tenantId' | 'scopeId'> }>,
  options: { basePath?: string } = {},
) {
  const catalog = assistantCatalog(driveOperations);
  const path = `${options.basePath ?? '/api'}/mcp`;
  // The platform mount reads a body whole before anything here runs, so a declared size past what a
  // tool can take (an inline upload, base64) is refused first. Larger files go by upload link.
  app.use(path, async (c, next) => {
    const declared = Number(c.req.header('content-length') ?? '');
    if (c.req.method === 'POST' && Number.isFinite(declared) && declared > MAX_MCP_BODY_BYTES) {
      throw new HTTPException(413, { message: 'This request is too large. Upload larger files with drive_create-upload-link.' });
    }
    await next();
  });
  return mountMcp(app, catalog, async (c) => {
    if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      throw new HTTPException(415, { message: 'Use application/json for this request.' });
    }
    const { access, ids } = await resolve(c as Context<E>, bearerOnly(c.req.raw));
    return assistantStub(access, driveOperations, ids);
  }, { basePath: options.basePath ?? '/api', serverInfo: { name: 'drive' } });
}
