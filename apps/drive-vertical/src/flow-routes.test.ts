import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { FlowGraph } from '@canopy/scope-drive/spec/model';
import { mountFlows, type FlowAccess, type FlowScope, type FlowSite, type FlowStore } from './flow-routes';
import type { DirectoryFlow, FlowScopes } from './flow-directory';
import type { DeliveryView, FlowList, FlowPreview, FlowView } from './flow-contract';

const graph = (over: Partial<FlowGraph> = {}): FlowGraph => ({
  versions: 'first',
  nodes: [
    { id: 't', type: 'trigger', on: 'arrived', spaces: ['bank'] },
    { id: 'copy', type: 'copy', space: 'a3docs', folderId: 'bancos', alsoIn: [] },
  ],
  edges: [{ from: 't', to: 'copy', branch: 'next' }],
  ...over,
});

const stored = (id: string, scopes: FlowScopes, over: Partial<DirectoryFlow> = {}): { flow: DirectoryFlow; scopes: FlowScopes } => ({
  flow: { id, name: id, enabled: true, graph: graph(), author: 'Ada', authorSub: 'ada', createdAt: 'c', updatedAt: 'u', failures: 0, pausedReason: null, ...over },
  scopes,
});

/** Ada owns `bank` and `a3docs`, and is only a member of `shared`. */
function app(opts: { flows?: { flow: DirectoryFlow; scopes: FlowScopes }[]; bank?: Record<string, unknown>; start?: FlowAccess['start'] } = {}) {
  const bankInvoke = vi.fn(async (op: string, input?: Record<string, unknown>) => {
    if (opts.bank && op in opts.bank) {
      const answer = opts.bank[op];
      return typeof answer === 'function' ? (answer as (i?: Record<string, unknown>) => unknown)(input) : answer;
    }
    throw new Error(`unexpected ${op}`);
  });
  const a3docs: FlowScope = { invoke: vi.fn(async (op: string, input?: Record<string, unknown>) => {
    if (op === 'drive/flow-deliveries') return { deliveries: [] };
    if (op === 'drive/get-source') return { source: { provider: 'canopy.a3doc', canUpload: true } };
    if (input?.folderId === 'bancos') return { id: 'bancos', path: 'Bancos', canWrite: true };
    if (input?.folderId === 'read-only') return { id: 'read-only', canWrite: false };
    throw new Error('not_found');
  }) as FlowScope['invoke'] };
  const sites: FlowSite[] = [
    { slug: 'bank', name: 'Bank', scopeId: 's-bank', scope: { invoke: bankInvoke } as FlowScope, manages: true },
    { slug: 'a3docs', name: 'Gestoría', scopeId: 's-a3', scope: a3docs, manages: true },
    { slug: 'shared', name: 'Shared', scopeId: 's-shared', scope: { invoke: vi.fn() } as unknown as FlowScope, manages: false },
  ];
  const flows = opts.flows ?? [];
  const store: FlowStore = {
    list: vi.fn(async () => flows),
    save: vi.fn(async (input) => ({ ...input, createdAt: input.now, updatedAt: input.now, failures: 0, pausedReason: null })),
    delete: vi.fn(async () => {}),
  };
  const start = vi.fn(opts.start ?? (async () => {}));
  const access: FlowAccess = { sub: 'ada', author: 'Ada', tenantId: 't', sites: async () => sites, store, newId: () => 'new-id', now: () => 'now', start };
  const hono = new Hono();
  mountFlows(hono, async () => access);
  const call = (method: string, path: string, body?: unknown) => hono.request(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { call, bankInvoke, store, start };
}

describe('listing flows', () => {
  it('shows a flow only to someone who owns every space it touches, tagged with them', async () => {
    const a = app({ flows: [
      stored('mine', { watch: ['s-bank'], write: ['s-a3'] }),
      stored('not-mine', { watch: ['s-bank'], write: ['s-shared'] }),
      stored('orphan', { watch: [], write: [] }),
      stored('someone-elses-orphan', { watch: [], write: [] }, { authorSub: 'bob' }),
    ] });
    const body = await (await a.call('GET', '/api/flows')).json() as FlowList;
    expect(body.flows.map((f) => f.id)).toEqual(['mine', 'orphan']);
    expect(body.flows[0]!.spaces).toEqual([{ slug: 'bank', name: 'Bank', watch: true, write: false }, { slug: 'a3docs', name: 'Gestoría', watch: false, write: true }]);
    expect(body.flows[0]).not.toHaveProperty('authorSub');
    expect(body.spaces).toEqual([{ slug: 'bank', name: 'Bank', a3doc: false }, { slug: 'a3docs', name: 'Gestoría', a3doc: true }]);
  });
});

describe('saving a flow', () => {
  it('saves it as the caller login, with the spaces it touches by scope', async () => {
    const a = app();
    const res = await a.call('PUT', '/api/flows', { name: 'Statements', enabled: true, graph: graph() });
    expect(res.status).toBe(200);
    expect(a.store.save).toHaveBeenCalledWith(expect.objectContaining({
      id: 'new-id', authorSub: 'ada', author: 'Ada', name: 'Statements', scopes: { watch: ['s-bank'], write: ['s-a3'] },
    }), true);
    expect(((await res.json()) as FlowView).spaces.map((s) => s.slug)).toEqual(['bank', 'a3docs']);
  });

  it('refuses a space the caller does not own, a folder they cannot add to, and a graph that cannot run', async () => {
    const a = app();
    const copyTo = (space: string, folderId: string) => graph({ nodes: [graph().nodes[0]!, { id: 'copy', type: 'copy', space, folderId, alsoIn: [] }] });
    expect((await a.call('PUT', '/api/flows', { name: 'x', enabled: true, graph: copyTo('shared', 'bancos') })).status).toBe(403);
    expect((await a.call('PUT', '/api/flows', { name: 'x', enabled: true, graph: copyTo('nope', 'bancos') })).status).toBe(403);
    expect((await a.call('PUT', '/api/flows', { name: 'x', enabled: true, graph: copyTo('a3docs', 'read-only') })).status).toBe(400);
    const watchShared = graph({ nodes: [{ id: 't', type: 'trigger', on: 'arrived', spaces: ['shared'] }, graph().nodes[1]!] });
    expect((await a.call('PUT', '/api/flows', { name: 'x', enabled: true, graph: watchShared })).status).toBe(403);
    const loose = await a.call('PUT', '/api/flows', { name: 'x', enabled: true, graph: graph({ edges: [] }) });
    expect(loose.status).toBe(400);
    expect(await loose.text()).toContain('Connect the trigger to the first step.');
    expect(a.store.save).not.toHaveBeenCalled();
  });

  it('replaces only a flow the caller can see', async () => {
    const a = app({ flows: [stored('mine', { watch: ['s-bank'], write: ['s-a3'] }), stored('theirs', { watch: ['s-shared'], write: [] })] });
    expect((await a.call('PUT', '/api/flows', { id: 'theirs', name: 'x', enabled: true, graph: graph() })).status).toBe(404);
    expect((await a.call('PUT', '/api/flows', { id: 'mine', name: 'x', enabled: true, graph: graph() })).status).toBe(200);
    expect(a.store.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'mine' }), false);
  });
});

describe('deleting and running', () => {
  it('deletes a visible flow and its history in the spaces it watched', async () => {
    const a = app({ flows: [stored('mine', { watch: ['s-bank'], write: ['s-a3'] })], bank: { 'drive/delete-flow': { ok: true } } });
    expect((await a.call('DELETE', '/api/flows/theirs')).status).toBe(404);
    expect((await a.call('DELETE', '/api/flows/mine')).status).toBe(200);
    expect(a.store.delete).toHaveBeenCalledWith('mine');
    expect(a.bankInvoke).toHaveBeenCalledWith('drive/delete-flow', { id: 'mine' });
  });

  it('runs a flow over what is already in each space it watches', async () => {
    const a = app({ flows: [stored('mine', { watch: ['s-bank', 's-a3'], write: [] }), stored('off', { watch: ['s-bank'], write: [] }, { enabled: false })] });
    expect((await a.call('POST', '/api/flows/mine/run')).status).toBe(202);
    expect(a.start).toHaveBeenCalledWith('s-bank', 'flow-backfill', 'mine', expect.objectContaining({ scopeId: 's-bank', flowId: 'mine' }));
    expect(a.start).toHaveBeenCalledWith('s-a3', 'flow-backfill', 'mine', expect.objectContaining({ scopeId: 's-a3' }));
    expect((await a.call('POST', '/api/flows/off/run')).status).toBe(409);
  });
});

describe('deliveries', () => {
  const key = { space: 'bank', flowId: 'mine', fileId: 'file', versionId: 'v1' };
  const flows = [stored('mine', { watch: ['s-bank'], write: ['s-a3'] })];

  it('lists what the caller’s flows did, with the space and the flow’s name', async () => {
    const a = app({ flows, bank: { 'drive/flow-deliveries': { deliveries: [
      { flowId: 'mine', fileId: 'f', versionId: 'v', fileName: 'a.pdf', state: 'proposed', detail: {}, attempts: 0, createdAt: 'c', updatedAt: '2' },
      { flowId: 'hidden', fileId: 'g', versionId: 'v', fileName: 'b.pdf', state: 'proposed', detail: {}, attempts: 0, createdAt: 'c', updatedAt: '3' },
    ] } } });
    const body = await (await a.call('GET', '/api/flow-deliveries?state=proposed')).json() as { deliveries: DeliveryView[] };
    expect(body.deliveries).toEqual([expect.objectContaining({ flowId: 'mine', space: 'bank', flowName: 'mine' })]);
    expect(a.bankInvoke).toHaveBeenCalledWith('drive/flow-deliveries', { state: 'proposed', limit: 50 });
  });

  it('starts the run in the document’s space on approval, and nothing on dismissal', async () => {
    const a = app({ flows, bank: { 'drive/record-flow-delivery': { changed: true, delivery: { state: 'approved' }, previous: 'proposed' } } });
    expect((await a.call('POST', '/api/flow-deliveries/decide', { ...key, decision: 'approve' })).status).toBe(200);
    expect(a.bankInvoke).toHaveBeenCalledWith('drive/record-flow-delivery', expect.objectContaining({ state: 'approved', expect: ['proposed'] }));
    expect(a.start).toHaveBeenCalledWith('s-bank', 'flow-run', 'mine:file:v1', expect.objectContaining({ approved: true, scopeId: 's-bank' }));
    const b = app({ flows, bank: { 'drive/record-flow-delivery': { changed: true, delivery: { state: 'dismissed' }, previous: 'proposed' } } });
    await b.call('POST', '/api/flow-deliveries/decide', { ...key, decision: 'dismiss' });
    expect(b.start).not.toHaveBeenCalled();
    // A space the flow does not watch has no deliveries of it.
    expect((await a.call('POST', '/api/flow-deliveries/decide', { ...key, space: 'a3docs', decision: 'approve' })).status).toBe(404);
  });

  it('retries past the wait only what a person had approved', async () => {
    const approved = app({ flows, bank: {
      'drive/flow-deliveries': { deliveries: [{ ...key, state: 'failed', detail: { approved: true } }] },
      'drive/record-flow-delivery': { changed: true, delivery: { state: 'approved' }, previous: 'failed' },
    } });
    expect((await approved.call('POST', '/api/flow-deliveries/decide', { ...key, decision: 'retry' })).status).toBe(200);
    expect(approved.start).toHaveBeenCalledWith('s-bank', 'flow-run', 'mine:file:v1', expect.objectContaining({ approved: true }));
    // From before graphs: `matched` meant the same.
    const legacy = app({ flows, bank: {
      'drive/flow-deliveries': { deliveries: [{ ...key, state: 'failed', detail: { matched: true } }] },
      'drive/record-flow-delivery': { changed: true, delivery: { state: 'approved' }, previous: 'failed' },
    } });
    await legacy.call('POST', '/api/flow-deliveries/decide', { ...key, decision: 'retry' });
    expect(legacy.start).toHaveBeenCalledWith('s-bank', 'flow-run', 'mine:file:v1', expect.objectContaining({ approved: true }));
    const unasked = app({ flows, bank: { 'drive/flow-deliveries': { deliveries: [{ ...key, state: 'failed', detail: { error: "Couldn't ask the model", approved: false } }] } } });
    expect((await unasked.call('POST', '/api/flow-deliveries/decide', { ...key, decision: 'retry' })).status).toBe(200);
    expect(unasked.bankInvoke).not.toHaveBeenCalledWith('drive/record-flow-delivery', expect.anything());
    expect(unasked.start).toHaveBeenCalledWith('s-bank', 'flow-run', 'mine:file:v1', expect.objectContaining({ approved: false }));
    const done = app({ flows, bank: { 'drive/flow-deliveries': { deliveries: [{ ...key, state: 'done', detail: {} }] } } });
    expect((await done.call('POST', '/api/flow-deliveries/decide', { ...key, decision: 'retry' })).status).toBe(409);
  });

  it('puts an approval back when its run cannot be started', async () => {
    const a = app({ flows, start: async () => { throw new Error('no runner'); }, bank: { 'drive/record-flow-delivery': { changed: true, delivery: { state: 'approved' }, previous: 'proposed' } } });
    expect((await a.call('POST', '/api/flow-deliveries/decide', { ...key, decision: 'approve' })).status).toBe(500);
    expect(a.bankInvoke).toHaveBeenLastCalledWith('drive/record-flow-delivery', expect.objectContaining({ state: 'proposed', expect: ['approved'] }));
  });
});

describe('previewing a flow', () => {
  const facts = (fileId: string, name: string, over: Record<string, unknown> = {}) => ({
    fileId, name, folderId: 'x', folderPath: '', state: 'live', versionId: `${fileId}-v1`, blobRef: null, mime: null, size: null,
    versionCreatedAt: null, labels: [], category: null, copiedByFlow: false, ...over,
  });
  const files = [facts('a', 'Statement 1.pdf'), facts('b', 'Invoice.pdf'), facts('c', 'notes.txt'), facts('d', 'Statement 2.pdf', { copiedByFlow: true })];
  const branching = graph({
    nodes: [
      { id: 't', type: 'trigger', on: 'arrived', spaces: ['bank'] },
      { id: 'pdf', type: 'check', condition: { field: 'extension', values: ['pdf'] } },
      { id: 'statement', type: 'check', condition: { field: 'ask', question: 'Is it a bank statement?' } },
      { id: 'copy', type: 'copy', space: 'a3docs', folderId: 'bancos', alsoIn: [] },
      { id: 'label', type: 'label', value: 'check me' },
    ],
    edges: [
      { from: 't', to: 'pdf', branch: 'next' },
      { from: 'pdf', to: 'statement', branch: 'yes' },
      { from: 'statement', to: 'copy', branch: 'yes' },
      { from: 'statement', to: 'label', branch: 'no' },
    ],
  });

  it('counts the documents reaching each step, marks what hinges on the model, and leaves out copies', async () => {
    const a = app({ bank: { 'drive/flow-candidates': { files, next: null } } });
    const res = await a.call('POST', '/api/flows/preview', { graph: branching });
    expect(res.status).toBe(200);
    const body = await res.json() as FlowPreview;
    expect(body).toMatchObject({ matched: 2, uncertain: 2, scanned: 4, truncated: false });
    expect(body.reach).toEqual({ t: 3, pdf: 3, statement: 2 });
    expect(body.maybe).toEqual({ copy: 2, label: 2 });
    expect(body.matches).toMatchObject([{ space: 'bank', fileId: 'a', needsAnswer: true, handled: false }, { fileId: 'b' }]);
  });

  it('marks what a saved flow already handled', async () => {
    const a = app({ bank: {
      'drive/flow-candidates': { files: files.slice(0, 1), next: null },
      'drive/flow-deliveries': (input?: Record<string, unknown>) => ({ deliveries: input?.fileId === 'a' ? [{ flowId: 'f1', fileId: 'a', versionId: 'a-v1', state: 'done' }] : [] }),
    } });
    const body = await (await a.call('POST', '/api/flows/preview', { id: 'f1', graph: graph() })).json() as FlowPreview;
    expect(body.matches).toMatchObject([{ fileId: 'a', handled: true, needsAnswer: false }]);
  });

  it('says where its copies file a document by its own year and month, and when it cannot tell', async () => {
    const byMonth = graph({
      nodes: [
        { id: 't', type: 'trigger', on: 'arrived', spaces: ['bank'] },
        { id: 'month', type: 'check', condition: { field: 'folder', op: 'matches', path: 'Client invoices/{year}/{month}' } },
        { id: 'copy', type: 'copy', space: 'a3docs', folderId: 'bancos', alsoIn: [], subfolder: '{year}/{month}', alsoInPaths: ['Facturas/{year}'] },
        { id: 'gone', type: 'copy', space: 'a3docs', folderId: 'deleted', alsoIn: [], subfolder: '{year}', alsoInPaths: ['Ventas/{year}'] },
      ],
      edges: [
        { from: 't', to: 'month', branch: 'next' },
        { from: 'month', to: 'copy', branch: 'yes' },
        { from: 'copy', to: 'gone', branch: 'next' },
      ],
    });
    const a = app({ bank: { 'drive/flow-candidates': { files: [facts('a', 'F-12.pdf', { folderPath: 'Client invoices/2026/09' })], next: null } } });
    const body = await (await a.call('POST', '/api/flows/preview', { graph: byMonth })).json() as FlowPreview;
    expect(body.matches[0]!.filedIn).toEqual([
      'Gestoría › Bancos/2026/09',
      'Gestoría › Facturas/2026',
      // Its folder is gone: no path below it is shown as if it were at the top. Categories by path still are.
      "Gestoría › can't tell: the folder it copies to isn't there",
      'Gestoría › Ventas/2026',
    ]);
  });

  it('refuses a graph that cannot run, and spaces the caller does not own', async () => {
    const a = app({ bank: { 'drive/flow-candidates': { files, next: null } } });
    expect((await a.call('POST', '/api/flows/preview', { graph: graph({ edges: [] }) })).status).toBe(400);
    const shared = graph({ nodes: [{ id: 't', type: 'trigger', on: 'arrived', spaces: ['shared'] }, graph().nodes[1]!] });
    expect((await a.call('POST', '/api/flows/preview', { graph: shared })).status).toBe(403);
  });
});
