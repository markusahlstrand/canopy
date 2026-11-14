import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mountFlows, type FlowAccess, type FlowScope } from './flow-routes';

const definition = { trigger: { on: 'arrived' }, actions: [{ type: 'copy', space: 'a3docs', folderId: 'bancos' }] };

function app(over: Partial<FlowAccess> = {}, here: Partial<Record<string, unknown>> = {}) {
  const invoke = vi.fn(async (op: string, input?: Record<string, unknown>) => {
    if (op in here) return here[op];
    if (op === 'drive/save-flow') return { id: 'f1', ...input };
    throw new Error(`unexpected ${op}`);
  });
  const target: FlowScope = { invoke: vi.fn(async (_op: string, input?: Record<string, unknown>) => {
    if (input?.folderId === 'bancos') return { id: 'bancos', canWrite: true };
    if (input?.folderId === 'read-only') return { id: 'read-only', canWrite: false };
    throw new Error('not_found');
  }) as FlowScope['invoke'] };
  const start = vi.fn(async () => {});
  const access: FlowAccess = {
    scope: { invoke } as FlowScope, sub: 'ada', node: { tenantId: 't', scopeId: 's' },
    sites: async () => [{ slug: 'a3docs', scope: target }], start, ...over,
  };
  const hono = new Hono();
  mountFlows(hono, async () => access);
  const call = (method: string, path: string, body?: unknown) => hono.request(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { call, invoke, start };
}

describe('saving a flow', () => {
  it('saves it as the caller login, once every copy target is reachable', async () => {
    const a = app();
    const res = await a.call('PUT', '/api/flows', { name: 'Statements', enabled: true, definition });
    expect(res.status).toBe(200);
    expect(a.invoke).toHaveBeenCalledWith('drive/save-flow', expect.objectContaining({ authorSub: 'ada', name: 'Statements' }));
  });
  it('refuses a space the caller cannot enter, or a folder they cannot reach there', async () => {
    const a = app();
    expect((await a.call('PUT', '/api/flows', { name: 'x', enabled: true, definition: { ...definition, actions: [{ type: 'copy', space: 'nope', folderId: 'bancos' }] } })).status).toBe(400);
    expect((await a.call('PUT', '/api/flows', { name: 'x', enabled: true, definition: { ...definition, actions: [{ type: 'copy', space: 'a3docs', folderId: 'other' }] } })).status).toBe(400);
    expect((await a.call('PUT', '/api/flows', { name: 'x', enabled: true, definition: { ...definition, actions: [{ type: 'copy', space: 'a3docs', folderId: 'read-only' }] } })).status).toBe(400);
    expect((await a.call('PUT', '/api/flows', { name: 'x', enabled: true, definition: { trigger: { on: 'arrived' }, actions: [] } })).status).toBe(400);
    expect(a.invoke).not.toHaveBeenCalledWith('drive/save-flow', expect.anything());
  });
});

describe('deciding a delivery', () => {
  const key = { flowId: 'f1', fileId: 'file', versionId: 'v1' };
  it('starts the run on approval, and nothing on dismissal', async () => {
    const a = app({}, { 'drive/record-flow-delivery': { changed: true, delivery: { state: 'approved' }, previous: 'proposed' } });
    expect((await a.call('POST', '/api/flow-deliveries/decide', { ...key, decision: 'approve' })).status).toBe(200);
    expect(a.invoke).toHaveBeenCalledWith('drive/record-flow-delivery', expect.objectContaining({ state: 'approved', expect: ['proposed'] }));
    expect(a.start).toHaveBeenCalledWith('flow-run', 'f1:file:v1', expect.objectContaining({ approved: true }));
    const b = app({}, { 'drive/record-flow-delivery': { changed: true, delivery: { state: 'dismissed' }, previous: 'proposed' } });
    await b.call('POST', '/api/flow-deliveries/decide', { ...key, decision: 'dismiss' });
    expect(b.start).not.toHaveBeenCalled();
  });
  it('retries only a failed delivery, and says when someone already decided', async () => {
    const a = app({}, { 'drive/flow-deliveries': { deliveries: [{ ...key, state: 'done', detail: {} }] } });
    expect((await a.call('POST', '/api/flow-deliveries/decide', { ...key, decision: 'retry' })).status).toBe(409);
    expect(a.start).not.toHaveBeenCalled();
  });
  it('retries without asking again only what had matched before it failed', async () => {
    const matched = app({}, {
      'drive/flow-deliveries': { deliveries: [{ ...key, state: 'failed', detail: { matched: true } }] },
      'drive/record-flow-delivery': { changed: true, delivery: { state: 'approved' }, previous: 'failed' },
    });
    expect((await matched.call('POST', '/api/flow-deliveries/decide', { ...key, decision: 'retry' })).status).toBe(200);
    expect(matched.invoke).toHaveBeenCalledWith('drive/record-flow-delivery', expect.objectContaining({ state: 'approved', expect: ['failed'] }));
    expect(matched.start).toHaveBeenCalledWith('flow-run', 'f1:file:v1', expect.objectContaining({ approved: true }));
    // Its question was never answered: it stays failed, and the run asks again.
    const unasked = app({}, { 'drive/flow-deliveries': { deliveries: [{ ...key, state: 'failed', detail: { error: "Couldn't ask the model" } }] } });
    expect((await unasked.call('POST', '/api/flow-deliveries/decide', { ...key, decision: 'retry' })).status).toBe(200);
    expect(unasked.invoke).not.toHaveBeenCalledWith('drive/record-flow-delivery', expect.anything());
    expect(unasked.start).toHaveBeenCalledWith('flow-run', 'f1:file:v1', expect.objectContaining({ approved: false }));
  });
  it('puts an approval back when its run cannot be started', async () => {
    const a = app({ start: vi.fn(async () => { throw new Error('no runner'); }) }, { 'drive/record-flow-delivery': { changed: true, delivery: { state: 'approved' }, previous: 'proposed' } });
    expect((await a.call('POST', '/api/flow-deliveries/decide', { ...key, decision: 'approve' })).status).toBe(500);
    expect(a.invoke).toHaveBeenLastCalledWith('drive/record-flow-delivery', expect.objectContaining({ state: 'proposed', expect: ['approved'] }));
  });
});

describe('previewing a flow', () => {
  const facts = (fileId: string, folderPath: string, over: Record<string, unknown> = {}) => ({
    fileId, name: `${fileId}.pdf`, folderId: 'x', folderPath, state: 'live', versionId: `${fileId}-v1`, blobRef: null, mime: null, size: null,
    versionCreatedAt: null, labels: [], category: null, copiedByFlow: false, ...over,
  });
  const files = [facts('a', 'Statements'), facts('b', 'Statements/2026'), facts('c', 'Invoices'), facts('d', 'Statements', { copiedByFlow: true })];
  const under = { trigger: { on: 'arrived' }, conditions: [{ field: 'folder', op: 'under', path: 'Statements' }], actions: [{ type: 'label', value: 'x' }] };

  it('lists the documents already here that the flow would act on, without the copies a flow made', async () => {
    const a = app({}, { 'drive/flow-candidates': { files, next: null } });
    const res = await a.call('POST', '/api/flows/preview', { definition: under });
    expect(res.status).toBe(200);
    const body = await res.json() as { matches: { fileId: string; handled: boolean }[]; matched: number; scanned: number; truncated: boolean };
    expect(body.matches.map((m) => m.fileId)).toEqual(['a', 'b']);
    expect(body).toMatchObject({ matched: 2, scanned: 4, truncated: false });
    expect(body.matches.every((m) => !m.handled)).toBe(true);
  });

  it('marks what hinges on a model question, and what a saved flow already handled', async () => {
    const a = app();
    a.invoke.mockImplementation(async (op: string, input?: Record<string, unknown>) => {
      if (op === 'drive/flow-candidates') return { files: files.slice(0, 2), next: null };
      if (op === 'drive/flow-deliveries') return { deliveries: input?.fileId === 'a' ? [{ flowId: 'f1', fileId: 'a', versionId: 'a-v1', state: 'done' }] : [] };
      throw new Error(`unexpected ${op}`);
    });
    const res = await a.call('POST', '/api/flows/preview', { id: 'f1', definition: { ...under, conditions: [...under.conditions, { field: 'ask', question: 'Is it a bank statement?' }] } });
    const body = await res.json() as { matches: { fileId: string; handled: boolean; needsAnswer: boolean }[]; uncertain: number };
    expect(body.uncertain).toBe(2);
    expect(body.matches).toMatchObject([{ fileId: 'a', handled: true, needsAnswer: true }, { fileId: 'b', handled: false, needsAnswer: true }]);
  });

  it('needs only the conditions, and refuses a broken one', async () => {
    const a = app({}, { 'drive/flow-candidates': { files, next: null } });
    expect((await a.call('POST', '/api/flows/preview', { definition: { conditions: [] } })).status).toBe(200);
    expect((await a.call('POST', '/api/flows/preview', { definition: { conditions: [{ field: 'folder' }] } })).status).toBe(400);
  });
});
