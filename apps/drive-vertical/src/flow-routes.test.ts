import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { substratError } from '@substrat-run/contracts';
import type { FlowGraph } from '@canopy/scope-drive/spec/model';
import { mountFlows, type FlowAccess, type FlowScope, type FlowSite, type FlowStore } from './flow-routes';
import type { DirectoryFlow, FlowScopes } from './flow-directory';
import { DECIDE_BATCH_LIMIT, type DecisionResults, type DeliveryView, type FlowList, type FlowPreview, type FlowView } from './flow-contract';

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
function app(opts: { flows?: { flow: DirectoryFlow; scopes: FlowScopes }[]; bank?: Record<string, unknown>; start?: FlowAccess['start']; drive?: boolean } = {}) {
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
  const drive = vi.fn(async () => {});
  const access: FlowAccess = { sub: 'ada', author: 'Ada', tenantId: 't', sites: async () => sites, store, newId: () => 'new-id', now: () => 'now', start, ...(opts.drive ? { drive } : {}) };
  const hono = new Hono();
  mountFlows(hono, async () => access);
  const call = (method: string, path: string, body?: unknown) => hono.request(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { call, bankInvoke, store, start, drive };
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

  it('says where a proposal is and where it would go, as the run will go on after approval', async () => {
    const byMonth = graph({
      nodes: [
        { id: 't', type: 'trigger', on: 'arrived', spaces: ['bank'] },
        { id: 'month', type: 'check', condition: { field: 'folder', op: 'matches', path: 'Invoices/{year}/{month}' } },
        { id: 'early', type: 'copy', space: 'a3docs', folderId: 'bancos', alsoIn: [], subfolder: 'Early/{year}' },
        { id: 'ask', type: 'check', condition: { field: 'ask', question: 'Is it an invoice?' } },
        { id: 'w', type: 'approval' },
        { id: 'copy', type: 'copy', space: 'a3docs', folderId: 'bancos', alsoIn: [], subfolder: '{year}/{month}' },
      ],
      edges: [
        { from: 't', to: 'month', branch: 'next' }, { from: 'month', to: 'early', branch: 'yes' },
        { from: 'early', to: 'ask', branch: 'next' }, { from: 'ask', to: 'w', branch: 'yes' }, { from: 'w', to: 'copy', branch: 'next' },
      ],
    });
    const proposal = (fileId: string, versionId = 'v', detail: Record<string, unknown> = {}) =>
      ({ flowId: 'mine', fileId, versionId, fileName: `${fileId}.pdf`, state: 'proposed', detail, attempts: 0, createdAt: 'c', updatedAt: fileId });
    const a = app({ flows: [stored('mine', { watch: ['s-bank'], write: ['s-a3'] }, { graph: byMonth })], bank: {
      'drive/flow-deliveries': { deliveries: [
        // Waiting after the model said yes and the early copy was made.
        proposal('f1', 'v', { answers: { ask: true }, done: { early: { fileId: 'x' } } }),
        // Unasked: the walk stops at the model's question, so nothing after it is listed.
        proposal('f2'),
        // A newer version came since: where that one would go is not this one's destination.
        proposal('f3', 'old', { answers: { ask: true } }),
        proposal('gone'),
      ] },
      'drive/file-facts': (input?: Record<string, unknown>) => {
        if (input?.fileId === 'gone') throw new Error('not_found');
        return { fileId: input?.fileId, name: 'x.pdf', folderId: 'x', folderPath: 'Invoices/2026/09', state: 'live', versionId: 'v', labels: [], category: null, copiedByFlow: false };
      },
    } });
    const body = await (await a.call('GET', '/api/flow-deliveries?state=proposed&limit=200')).json() as { deliveries: DeliveryView[] };
    expect(Object.fromEntries(body.deliveries.map((d) => [d.fileId, [d.folderPath, d.filedIn]]))).toEqual({
      f1: ['Invoices/2026/09', ['Gestoría › Bancos/2026/09']],
      f2: ['Invoices/2026/09', ['Gestoría › Bancos/Early/2026']],
      f3: ['Invoices/2026/09', undefined],
      gone: [undefined, undefined],
    });
  });

  it('puts an approval back when its run cannot be started', async () => {
    const a = app({ flows, start: async () => { throw new Error('no runner'); }, bank: { 'drive/record-flow-delivery': { changed: true, delivery: { state: 'approved' }, previous: 'proposed' } } });
    expect((await a.call('POST', '/api/flow-deliveries/decide', { ...key, decision: 'approve' })).status).toBe(500);
    expect(a.bankInvoke).toHaveBeenLastCalledWith('drive/record-flow-delivery', expect.objectContaining({ state: 'proposed', expect: ['approved'] }));
  });
});

describe('deciding several at once', () => {
  const flows = [stored('mine', { watch: ['s-bank'], write: ['s-a3'] }), stored('theirs', { watch: ['s-bank', 's-shared'], write: [] })];
  const item = (fileId: string, decision: 'approve' | 'dismiss' | 'retry' = 'approve', over: Record<string, string> = {}) =>
    ({ space: 'bank', flowId: 'mine', fileId, versionId: 'v1', decision, ...over });

  /** A space that keeps each delivery's state and moves it only from the state a decision expects, as the scope does. */
  function bank(states: Record<string, string>, refuse: string[] = []) {
    return {
      'drive/record-flow-delivery': (input?: Record<string, unknown>) => {
        const { fileId, state, expect: from } = input as { fileId: string; state: string; expect: string[] };
        if (refuse.includes(fileId)) throw substratError('forbidden', 'You cannot change deliveries here.');
        const previous = states[fileId] ?? 'none';
        if (!from.includes(previous)) return { changed: false, delivery: null, previous };
        states[fileId] = state;
        return { changed: true, delivery: { flowId: 'mine', fileId, versionId: 'v1', state }, previous };
      },
    };
  }
  const decideMany = async (a: ReturnType<typeof app>, items: unknown[]) => {
    const res = await a.call('POST', '/api/flow-deliveries/decide', { items });
    expect(res.status).toBe(200);
    return (await res.json() as DecisionResults).results;
  };

  it('approves each, starts its run, and drives the space once', async () => {
    const states: Record<string, string> = { a: 'proposed', b: 'proposed', c: 'proposed' };
    const a = app({ flows, drive: true, bank: bank(states) });
    const results = await decideMany(a, ['a', 'b', 'c'].map((f) => item(f)));
    expect(results).toEqual(['a', 'b', 'c'].map((fileId) => ({ space: 'bank', flowId: 'mine', fileId, versionId: 'v1', ok: true, state: 'approved' })));
    expect(states).toEqual({ a: 'approved', b: 'approved', c: 'approved' });
    expect(a.start).toHaveBeenCalledTimes(3);
    expect(a.start).toHaveBeenCalledWith('s-bank', 'flow-run', 'mine:a:v1', expect.objectContaining({ approved: true }), { drive: false });
    expect(a.drive).toHaveBeenCalledTimes(1);
    expect(a.drive).toHaveBeenCalledWith('s-bank', 3);
  });

  it('rejects each without starting anything', async () => {
    const states: Record<string, string> = { a: 'proposed', b: 'proposed' };
    const a = app({ flows, drive: true, bank: bank(states) });
    const results = await decideMany(a, [item('a', 'dismiss'), item('b', 'dismiss')]);
    expect(results.map((r) => r.ok && r.state)).toEqual(['dismissed', 'dismissed']);
    expect(states).toEqual({ a: 'dismissed', b: 'dismissed' });
    expect(a.start).not.toHaveBeenCalled();
    expect(a.drive).not.toHaveBeenCalled();
  });

  it('keeps what succeeded when others fail, and says which failed and why', async () => {
    const states: Record<string, string> = { ok: 'proposed', decided: 'dismissed', refused: 'proposed', broken: 'proposed' };
    const a = app({
      flows, drive: true, bank: bank(states, ['refused']),
      start: async (_scope, _job, instance) => { if (instance === 'mine:broken:v1') throw new Error('no runner'); },
    });
    const results = await decideMany(a, [item('ok'), item('decided'), item('missing'), item('refused'), item('broken'), item('x', 'approve', { flowId: 'nope' })]);
    expect(results).toEqual([
      expect.objectContaining({ fileId: 'ok', ok: true, state: 'approved' }),
      expect.objectContaining({ fileId: 'decided', ok: false, status: 409, error: 'Someone already decided this one.' }),
      expect.objectContaining({ fileId: 'missing', ok: false, status: 409, error: 'There is no such delivery.' }),
      expect.objectContaining({ fileId: 'refused', ok: false, status: 403, error: 'You cannot change deliveries here.' }),
      expect.objectContaining({ fileId: 'broken', ok: false, error: 'no runner' }),
      expect.objectContaining({ fileId: 'x', flowId: 'nope', ok: false, status: 404, error: 'Flow not found.' }),
    ]);
    // The one approved stays approved; the one whose run could not start is put back to wait.
    expect(states).toMatchObject({ ok: 'approved', decided: 'dismissed', refused: 'proposed', broken: 'proposed' });
    // Driven for the one run that started.
    expect(a.drive).toHaveBeenCalledWith('s-bank', 1);
  });

  it('approves a delivery once, however many times it is asked', async () => {
    const states: Record<string, string> = { a: 'proposed' };
    const a = app({ flows, drive: true, bank: bank(states) });
    // Twice in one batch (a double click), then again from another tab.
    const first = await decideMany(a, [item('a'), item('a')]);
    expect(first.filter((r) => r.ok)).toHaveLength(1);
    expect(first.find((r) => !r.ok)).toMatchObject({ status: 409, error: 'Someone already decided this one.' });
    const again = await decideMany(a, [item('a')]);
    expect(again).toEqual([expect.objectContaining({ ok: false, status: 409 })]);
    const single = await a.call('POST', '/api/flow-deliveries/decide', item('a', 'dismiss'));
    expect(single.status).toBe(409);
    expect(a.start).toHaveBeenCalledTimes(1);
    expect(states.a).toBe('approved');
  });

  it('refuses deliveries of a flow over a space the caller does not own, and touches nothing there', async () => {
    const states: Record<string, string> = { a: 'proposed' };
    const a = app({ flows, drive: true, bank: bank(states) });
    const results = await decideMany(a, [item('a', 'approve', { flowId: 'theirs' }), item('a', 'approve', { space: 'shared' })]);
    expect(results).toEqual([
      expect.objectContaining({ ok: false, status: 404, error: 'Flow not found.' }),
      expect.objectContaining({ ok: false, status: 404, error: 'There is no such delivery.' }),
    ]);
    expect(states.a).toBe('proposed');
    expect(a.bankInvoke).not.toHaveBeenCalled();
    expect(a.start).not.toHaveBeenCalled();
  });

  it('takes a batch only of a size it can finish', async () => {
    const a = app({ flows });
    expect((await a.call('POST', '/api/flow-deliveries/decide', { items: [] })).status).toBe(400);
    const tooMany = Array.from({ length: DECIDE_BATCH_LIMIT + 1 }, (_, i) => item(`f${i}`));
    expect((await a.call('POST', '/api/flow-deliveries/decide', { items: tooMany })).status).toBe(400);
    expect((await a.call('POST', '/api/flow-deliveries/decide', { items: [{ ...item('a'), decision: 'maybe' }] })).status).toBe(400);
  });

  it('drives each run on its own when the host cannot drive a space once for the batch', async () => {
    const states: Record<string, string> = { a: 'proposed', b: 'proposed' };
    const a = app({ flows, bank: bank(states) });
    await decideMany(a, [item('a'), item('b')]);
    expect(a.start).toHaveBeenCalledWith('s-bank', 'flow-run', 'mine:a:v1', expect.objectContaining({ approved: true }));
    expect(a.start.mock.calls.every((call) => call.length === 4)).toBe(true);
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
