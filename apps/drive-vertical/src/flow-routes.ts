import type { Context, Env, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { capturesOn, copyPaths, flowGraph, isAction, reach, spacesOf, walk, type FileFactsRow, type FlowDelivery, type FlowGraph } from '@canopy/scope-drive/spec/model';
import type { DeliveryDetail, DeliveryView, FlowList, FlowPreview, FlowSpace, FlowView, PreviewMatch } from './flow-contract.js';
import { alreadyHandled, FLOW_BACKFILL_JOB, FLOW_RUN_JOB } from './automation.js';
import type { DirectoryFlow, FlowScopes, SaveFlow } from './flow-directory.js';
import { flowSaveInput } from './flow-contract.js';

export interface FlowScope {
  invoke<T>(operation: string, input?: Record<string, unknown>): Promise<T>;
}

/** A space the caller can enter, as the caller there. */
export interface FlowSite { slug: string; name: string; scopeId: string; scope: FlowScope; manages: boolean }

/** The install's flows, as the routes reach them. */
export interface FlowStore {
  list(): Promise<{ flow: DirectoryFlow; scopes: FlowScopes }[]>;
  save(input: SaveFlow, create: boolean): Promise<DirectoryFlow | { error: 'limit' | 'not_found' }>;
  delete(id: string): Promise<void>;
}

/** What a flow route acts with: who the caller is as a login, and the spaces they can enter. */
export interface FlowAccess {
  /** The caller's login: a flow they save acts as it, in every space it touches. */
  sub: string;
  /** How people see the caller, on the flows they save. */
  author: string;
  sites(): Promise<FlowSite[]>;
  store: FlowStore;
  newId(): string;
  now(): string;
  /** Start (or join) a drive job in a space, then drive due runs after the response. */
  start(scopeId: string, job: string, instance: string, payload: Record<string, unknown>): Promise<void>;
  tenantId: string;
}

const previewInput = z.object({ id: z.string().min(1).max(64).optional(), graph: flowGraph });

/** How many documents a preview reads, and how many matches it lists. */
export const PREVIEW_SCAN_LIMIT = 5_000;
export const PREVIEW_LIST_LIMIT = 50;
const PREVIEW_PAGE = 200;

const decideInput = z.object({
  space: z.string().min(1), flowId: z.string().min(1), fileId: z.string().min(1), versionId: z.string().min(1),
  decision: z.enum(['approve', 'dismiss', 'retry']),
});

const deliveriesQuery = z.object({
  flowId: z.string().optional(),
  state: z.enum(['proposed', 'approved', 'running', 'done', 'failed', 'dismissed', 'skipped']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const incomplete = (error: z.ZodError) => {
  const issue = error.issues[0];
  return `This flow isn't complete: ${issue?.message ?? 'check its steps'}.`;
};

/**
 * Flows, as the app edits and runs them. A flow belongs to the install; each route answers only
 * about flows whose every space the caller owns (watched or copied into), and saving a flow
 * requires owning every space it names. The flow then acts as the caller's login, which is
 * checked again in each space every time it runs.
 */
export function mountFlows<E extends Env>(app: Hono<E>, resolve: (c: Context<E>) => Promise<FlowAccess>) {
  /** The caller's spaces, and which flows they may see: those all of whose spaces they own. */
  async function seen(access: FlowAccess) {
    const sites = await access.sites();
    const managed = new Map(sites.filter((s) => s.manages).map((s) => [s.scopeId, s]));
    const visible = (await access.store.list()).filter(({ flow, scopes }) => {
      const all = [...scopes.watch, ...scopes.write];
      // A flow whose spaces are all gone is left to whoever saved it.
      return all.length ? all.every((scope) => managed.has(scope)) : flow.authorSub === access.sub;
    });
    return { sites, managed, visible };
  }

  const view = (flow: DirectoryFlow, scopes: FlowScopes, managed: Map<string, FlowSite>): FlowView => {
    const { authorSub: _sub, ...rest } = flow;
    const spaces: FlowSpace[] = [...new Set([...scopes.watch, ...scopes.write])].flatMap((scope) => {
      const site = managed.get(scope);
      return site ? [{ slug: site.slug, name: site.name, watch: scopes.watch.includes(scope), write: scopes.write.includes(scope) }] : [];
    });
    return { ...rest, spaces };
  };

  async function visibleFlow(access: FlowAccess, id: string) {
    const ctx = await seen(access);
    const found = ctx.visible.find((v) => v.flow.id === id);
    if (!found) throw new HTTPException(404, { message: 'Flow not found.' });
    return { ...ctx, ...found };
  }

  app.get('/api/flows', async (c) => {
    const access = await resolve(c);
    const { managed, visible } = await seen(access);
    const list: FlowList = {
      flows: visible.map(({ flow, scopes }) => view(flow, scopes, managed)),
      spaces: await Promise.all([...managed.values()].map(async (s) => {
        const { source } = await s.scope.invoke<{ source: { provider: string; canUpload: boolean } | null }>('drive/get-source').catch(() => ({ source: null }));
        return { slug: s.slug, name: s.name, a3doc: source?.provider === 'canopy.a3doc' && source.canUpload };
      })),
    };
    return c.json(list);
  });

  app.put('/api/flows', async (c) => {
    const access = await resolve(c);
    const parsed = flowSaveInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: incomplete(parsed.error) });
    const input = parsed.data;
    const { managed, visible } = await seen(access);
    if (input.id && !visible.some((v) => v.flow.id === input.id)) throw new HTTPException(404, { message: 'Flow not found.' });
    const bySlug = new Map([...managed.values()].map((s) => [s.slug, s]));
    const { watch, write } = spacesOf(input.graph);
    for (const slug of new Set([...watch, ...write])) {
      if (!bySlug.has(slug)) throw new HTTPException(403, { message: `Only someone who owns the space '${slug}' can use it in a flow.` });
    }
    for (const node of input.graph.nodes) {
      if (node.type !== 'copy') continue;
      const site = bySlug.get(node.space)!;
      // Categories named by path are made below the top folder when missing: the author must be able to add there.
      for (const folderId of [node.folderId, ...node.alsoIn, ...(node.alsoInPaths?.some((t) => t.trim()) ? ['root'] : [])]) {
        // The folder as the author sees it there: it exists, and they may add files to it.
        const folder = await site.scope.invoke<{ id: string; canWrite?: boolean }>('drive/get-folder', { folderId }).catch(() => null);
        if (!folder?.canWrite) throw new HTTPException(400, { message: `A folder this flow copies to is not one you can add files to in '${node.space}'.` });
      }
    }
    const scopes: FlowScopes = { watch: watch.map((s) => bySlug.get(s)!.scopeId), write: write.map((s) => bySlug.get(s)!.scopeId) };
    const saved = await access.store.save({
      id: input.id ?? access.newId(), name: input.name, enabled: input.enabled, graph: input.graph,
      author: access.author, authorSub: access.sub, scopes, now: access.now(),
    }, !input.id);
    if ('error' in saved) {
      throw new HTTPException(saved.error === 'limit' ? 409 : 404, { message: saved.error === 'limit' ? 'This install already has as many flows as it can hold.' : 'Flow not found.' });
    }
    return c.json(view(saved, scopes, managed));
  });

  app.delete('/api/flows/:id', async (c) => {
    const access = await resolve(c);
    const { flow, scopes, managed } = await visibleFlow(access, c.req.param('id'));
    await access.store.delete(flow.id);
    // Its history goes with it, space by space; a space that refuses keeps rows nothing shows any more.
    await Promise.all(scopes.watch.map((scope) => managed.get(scope)?.scope.invoke('drive/delete-flow', { id: flow.id }).catch(() => null)));
    return c.json({ ok: true });
  });

  /**
   * Which documents already in the watched spaces a flow (saved or not) would reach an action in,
   * by the same walk the runner takes, and how many reach each step. Model questions are not
   * asked: a document whose path hinges on one counts as maybe. Copies a flow made are left out,
   * as the runner leaves them out.
   */
  app.post('/api/flows/preview', async (c) => {
    const access = await resolve(c);
    const parsed = previewInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: incomplete(parsed.error) });
    const { id, graph } = parsed.data;
    const { managed } = await seen(access);
    const bySlug = new Map([...managed.values()].map((s) => [s.slug, s]));
    const watched = spacesOf(graph).watch.map((slug) => {
      const site = bySlug.get(slug);
      if (!site) throw new HTTPException(403, { message: `Only someone who owns the space '${slug}' can use it in a flow.` });
      return site;
    });
    const actions = new Set(graph.nodes.filter(isAction).map((n) => n.id));
    const counts: Record<string, number> = {}, maybes: Record<string, number> = {};
    const found: { site: FlowSite; file: FileFactsRow; needsAnswer: boolean }[] = [];
    let matched = 0, uncertain = 0, scanned = 0, truncated = false;
    for (const site of watched) {
      let after: string | null = null;
      do {
        const page: { files: FileFactsRow[]; next: string | null } = await site.scope.invoke('drive/flow-candidates', { since: null, limit: PREVIEW_PAGE, ...(after ? { after } : {}) });
        for (const file of page.files) {
          scanned++;
          if (!file.versionId || file.state !== 'live' || file.copiedByFlow) continue;
          const { sure, maybe } = reach(graph, file);
          for (const n of sure) counts[n] = (counts[n] ?? 0) + 1;
          for (const n of maybe) maybes[n] = (maybes[n] ?? 0) + 1;
          const surely = [...sure].some((n) => actions.has(n));
          if (!surely && ![...maybe].some((n) => actions.has(n))) continue;
          matched++;
          if (!surely) uncertain++;
          if (found.length < PREVIEW_LIST_LIMIT) found.push({ site, file, needsAnswer: !surely });
        }
        after = page.next;
        if (after && scanned >= PREVIEW_SCAN_LIMIT) { truncated = true; break; }
      } while (after);
      if (truncated) break;
    }
    const flow = id ? { id, graph } : null;
    const filing = filedIn(graph, bySlug);
    const matches = await Promise.all(found.map(async ({ site, file, needsAnswer }): Promise<PreviewMatch> => {
      const where = await filing(file);
      return {
        space: site.slug, fileId: file.fileId, name: file.name, folderPath: file.folderPath, category: file.category?.id ?? null, needsAnswer,
        handled: flow ? await alreadyHandled(site.scope, flow, file.fileId, file.versionId!) : false,
        ...(where.length ? { filedIn: where } : {}),
      };
    }));
    return c.json({ matches, matched, uncertain, reach: counts, maybe: maybes, scanned, truncated } satisfies FlowPreview);
  });

  /** Run a flow over the documents already in each space it watches: each one it reaches an action in is proposed or acted on, once. */
  app.post('/api/flows/:id/run', async (c) => {
    const access = await resolve(c);
    const { flow, scopes } = await visibleFlow(access, c.req.param('id'));
    if (!flow.enabled) throw new HTTPException(409, { message: 'Turn the flow on before running it.' });
    for (const scope of scopes.watch) {
      await access.start(scope, FLOW_BACKFILL_JOB, flow.id, { tenantId: access.tenantId, scopeId: scope, flowId: flow.id });
    }
    return c.json({ started: true }, 202);
  });

  /** What the caller's flows did, newest first, from every space they watch. */
  app.get('/api/flow-deliveries', async (c) => {
    const access = await resolve(c);
    const query = deliveriesQuery.safeParse(c.req.query());
    if (!query.success) throw new HTTPException(400, { message: 'Ask for a flow, a state and how many.' });
    const { flowId, state, limit = 50 } = query.data;
    const { managed, visible } = await seen(access);
    const flows = visible.filter((v) => !flowId || v.flow.id === flowId);
    const names = new Map(flows.map((v) => [v.flow.id, v.flow.name]));
    const scopes = new Set(flows.flatMap((v) => v.scopes.watch));
    const lists = await Promise.all([...scopes].map(async (scope) => {
      const site = managed.get(scope);
      if (!site) return [];
      const { deliveries } = await site.scope.invoke<{ deliveries: FlowDelivery[] }>('drive/flow-deliveries', {
        ...(flowId ? { flowId } : {}), ...(state ? { state } : {}), limit,
      }).catch(() => ({ deliveries: [] as FlowDelivery[] }));
      return deliveries.filter((d) => names.has(d.flowId)).map((d): DeliveryView => ({ ...d, space: site.slug, flowName: names.get(d.flowId)! }));
    }));
    const deliveries = lists.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
    return c.json({ deliveries });
  });

  /** Approve or dismiss a proposal, or try a failed delivery again. */
  app.post('/api/flow-deliveries/decide', async (c) => {
    const access = await resolve(c);
    const parsed = decideInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: 'Say which delivery, and approve, dismiss or retry.' });
    const { space, flowId, fileId, versionId, decision } = parsed.data;
    const { scopes, managed } = await visibleFlow(access, flowId);
    const site = [...managed.values()].find((s) => s.slug === space);
    if (!site || !scopes.watch.includes(site.scopeId)) throw new HTTPException(404, { message: 'There is no such delivery.' });
    const key = { flowId, fileId, versionId };
    const move = (state: string, expect: string[]) =>
      site.scope.invoke<{ changed: boolean; delivery: FlowDelivery | null; previous: string }>('drive/record-flow-delivery', { ...key, state, expect });
    const refuse = (previous: string): never => {
      throw new HTTPException(409, { message: previous === 'none' ? 'There is no such delivery.' : 'Someone already decided this one.' });
    };
    if (decision === 'dismiss') {
      const moved = await move('dismissed', ['proposed']);
      if (!moved.changed) refuse(moved.previous);
      return c.json(moved.delivery);
    }
    // A retry goes past the flow's wait only when a person had already approved it there (or, for a
    // delivery from before flows were graphs, when its conditions had all held). Otherwise it walks
    // again from the start, keeping the answers and finished actions it has, and proposes at the wait.
    let approved = true;
    if (decision === 'retry') {
      const { deliveries } = await site.scope.invoke<{ deliveries: FlowDelivery[] }>('drive/flow-deliveries', { flowId, fileId, limit: 200 });
      const delivery = deliveries.find((d) => d.versionId === versionId);
      if (!delivery || delivery.state !== 'failed') return refuse(delivery?.state ?? 'none');
      const detail = delivery.detail as DeliveryDetail & { matched?: unknown };
      approved = detail.approved ?? detail.matched === true;
    }
    const from = decision === 'retry' ? 'failed' : 'proposed';
    // Not approved, it stays failed: the run claims (or proposes) from there.
    const moved = approved ? await move('approved', [from]) : null;
    if (moved && !moved.changed) refuse(moved.previous);
    try {
      await access.start(site.scopeId, FLOW_RUN_JOB, `${flowId}:${fileId}:${versionId}`, { tenantId: access.tenantId, scopeId: site.scopeId, ...key, approved });
    } catch (error) {
      // No run is coming: put the delivery back, so it can be decided again rather than sit approved for good.
      if (approved) await move(from, ['approved']).catch(() => {});
      throw error;
    }
    return c.json(moved?.delivery ?? { ...key, state: 'failed' });
  });
}

/**
 * Where a flow's copies would file a document, for the copies whose folder or categories it works
 * out from the document's own folders: 'space › path' each, or why it can't tell. Only the copies
 * the document surely reaches (no model question before them).
 */
function filedIn(graph: FlowGraph, bySlug: Map<string, FlowSite>) {
  const bases = new Map<string, Promise<string | null>>();
  const baseOf = (space: string, folderId: string) => {
    const key = `${space}\n${folderId}`;
    let pending = bases.get(key);
    if (!pending) {
      const site = bySlug.get(space);
      pending = site
        ? site.scope.invoke<{ path: string } | null>('drive/get-folder', { folderId }).then((f) => f?.path ?? null, () => null)
        : Promise.resolve(null);
      bases.set(key, pending);
    }
    return pending;
  };
  return async (file: FileFactsRow): Promise<string[]> => {
    const { path } = walk(graph, file);
    const captures = capturesOn(graph, path, file);
    const out: string[] = [];
    for (const id of path) {
      const node = graph.nodes.find((n) => n.id === id);
      if (node?.type !== 'copy' || (!node.subfolder?.trim() && !node.alsoInPaths?.some((t) => t.trim()))) continue;
      const space = bySlug.get(node.space)?.name ?? node.space;
      try {
        const { subfolder, alsoInPaths } = copyPaths(node, captures);
        const base = await baseOf(node.space, node.folderId);
        const join = (a: string | null, b: string) => [a ?? '', b].filter(Boolean).join('/');
        out.push(`${space} › ${join(base, subfolder) || 'Top level'}`);
        for (const extra of alsoInPaths) out.push(`${space} › ${extra || 'Top level'}`);
      } catch (error) {
        out.push(`${space} › can't tell: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return out;
  };
}
