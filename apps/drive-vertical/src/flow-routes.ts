import type { Context, Env, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { flowDefinition, flowMatches, type FileFactsRow, type FlowDelivery, type StoredFlow } from '@canopy/scope-drive/spec/model';
import type { FlowPreview, PreviewMatch } from './flow-contract.js';
import { alreadyHandled, FLOW_BACKFILL_JOB, FLOW_RUN_JOB } from './automation.js';

export interface FlowScope {
  invoke<T>(operation: string, input?: Record<string, unknown>): Promise<T>;
}

/** What a flow route acts with: this space as a manager of it, and who that is as a login. */
export interface FlowAccess {
  /** This space, as the caller (who must manage it). */
  scope: FlowScope;
  /** The caller's login: the flow acts as it, in every space it touches. */
  sub: string;
  node: { tenantId: string; scopeId: string };
  /** The spaces this login can enter, each as the caller there. */
  sites(): Promise<{ slug: string; scope: FlowScope }[]>;
  /** Start (or join) a drive job in this space, then drive due runs after the response. */
  start(job: string, instance: string, payload: Record<string, unknown>): Promise<void>;
}

const saveInput = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
  definition: flowDefinition,
});

/** A preview needs only what decides a match: the conditions, and whether new versions count again. */
const previewInput = z.object({ id: z.string().min(1).max(64).optional(), definition: flowDefinition.pick({ conditions: true, versions: true }) });

/** How many documents a preview reads, and how many matches it lists. */
export const PREVIEW_SCAN_LIMIT = 5_000;
export const PREVIEW_LIST_LIMIT = 50;
const PREVIEW_PAGE = 200;

const decideInput = z.object({
  flowId: z.string().min(1), fileId: z.string().min(1), versionId: z.string().min(1),
  decision: z.enum(['approve', 'dismiss', 'retry']),
});

/**
 * Flows, as the app edits and runs them. Listing and deleting are drive operations
 * (`GET /api/flows`, `DELETE /api/flows/:id`); these are the routes that need the worker:
 *
 *  - **Saving** names the author as a LOGIN, which only the session knows, and checks every copy
 *    target as the author: the space must be one they can enter and the folder one they can
 *    write. A flow that would fail on its first run is refused when it is saved.
 *  - **Running on existing files** and **deciding a proposal** start jobs.
 */
export function mountFlows<E extends Env>(app: Hono<E>, resolve: (c: Context<E>) => Promise<FlowAccess>) {
  app.put('/api/flows', async (c) => {
    const access = await resolve(c);
    const parsed = saveInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: `This flow isn't complete: ${parsed.error.issues[0]?.message ?? 'check its fields'}.` });
    const input = parsed.data;
    const copies = input.definition.actions.filter((a) => a.type === 'copy');
    if (copies.length) {
      const sites = await access.sites();
      for (const action of copies) {
        const site = sites.find((s) => s.slug === action.space);
        if (!site) throw new HTTPException(400, { message: `You can't add files to the space '${action.space}'.` });
        for (const folderId of [action.folderId, ...action.alsoIn]) {
          // A read of the folder as the author there: it exists, and they may see it.
          const folder = await site.scope.invoke<{ id: string }>('drive/get-folder', { folderId }).catch(() => null);
          if (!folder) throw new HTTPException(400, { message: `A folder this flow copies to is not one you can reach in '${action.space}'.` });
        }
      }
    }
    try {
      const flow = await access.scope.invoke<StoredFlow>('drive/save-flow', { ...input, authorSub: access.sub });
      return c.json(flow);
    } catch (error) {
      throw new HTTPException(403, { message: error instanceof Error ? error.message : 'Only someone who manages this space can save its flows.' });
    }
  });

  /**
   * Which documents already here a flow (saved or not) would act on, by the same matching the
   * runner uses. Model questions are not asked: a document that hinges on one is marked so.
   * Copies a flow made are left out, as the runner leaves them out.
   */
  app.post('/api/flows/preview', async (c) => {
    const access = await resolve(c);
    const parsed = previewInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: `This flow isn't complete: ${parsed.error.issues[0]?.message ?? 'check its fields'}.` });
    const { id, definition } = parsed.data;
    const found: { file: FileFactsRow; needsAnswer: boolean }[] = [];
    let matched = 0, uncertain = 0, scanned = 0, after: string | null = null, truncated = false;
    do {
      const page: { files: FileFactsRow[]; next: string | null } = await access.scope.invoke('drive/flow-candidates', { since: null, limit: PREVIEW_PAGE, ...(after ? { after } : {}) });
      for (const file of page.files) {
        scanned++;
        if (!file.versionId || file.state !== 'live' || file.copiedByFlow) continue;
        const held = flowMatches(definition, file);
        if (held === false) continue;
        matched++;
        if (held === 'ask') uncertain++;
        if (found.length < PREVIEW_LIST_LIMIT) found.push({ file, needsAnswer: held === 'ask' });
      }
      after = page.next;
      if (after && scanned >= PREVIEW_SCAN_LIMIT) { truncated = true; break; }
    } while (after);
    const flow = id ? { id, definition } : null;
    const matches = await Promise.all(found.map(async ({ file, needsAnswer }): Promise<PreviewMatch> => ({
      fileId: file.fileId, name: file.name, folderPath: file.folderPath, category: file.category?.id ?? null, needsAnswer,
      handled: flow ? await alreadyHandled(access.scope, flow, file.fileId, file.versionId!) : false,
    })));
    return c.json({ matches, matched, uncertain, scanned, truncated } satisfies FlowPreview);
  });

  /** Run a flow over the files already in the space: each one it matches is proposed or acted on, once. */
  app.post('/api/flows/:id/run', async (c) => {
    const access = await resolve(c);
    const { flows } = await access.scope.invoke<{ flows: StoredFlow[] }>('drive/list-flows');
    const flow = flows.find((f) => f.id === c.req.param('id'));
    if (!flow) throw new HTTPException(404, { message: 'Flow not found.' });
    if (!flow.enabled) throw new HTTPException(409, { message: 'Turn the flow on before running it.' });
    await access.start(FLOW_BACKFILL_JOB, flow.id, { ...access.node, flowId: flow.id });
    return c.json({ started: true }, 202);
  });

  /** Approve or dismiss a proposal, or try a failed delivery again. */
  app.post('/api/flow-deliveries/decide', async (c) => {
    const access = await resolve(c);
    const parsed = decideInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: 'Say which delivery, and approve, dismiss or retry.' });
    const { flowId, fileId, versionId, decision } = parsed.data;
    const from = decision === 'retry' ? ['failed'] : ['proposed'];
    const state = decision === 'dismiss' ? 'dismissed' : 'approved';
    const moved = await access.scope.invoke<{ changed: boolean; delivery: FlowDelivery | null; previous: string }>('drive/record-flow-delivery', {
      flowId, fileId, versionId, state, expect: from,
    });
    if (!moved.changed) throw new HTTPException(409, { message: moved.previous === 'none' ? 'There is no such delivery.' : 'Someone already decided this one.' });
    if (state === 'approved') await access.start(FLOW_RUN_JOB, `${flowId}:${fileId}:${versionId}`, { ...access.node, flowId, fileId, versionId, approved: true });
    return c.json(moved.delivery);
  });
}
