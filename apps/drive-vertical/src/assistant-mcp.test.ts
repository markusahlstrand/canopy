import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { problemResponse } from '@substrat-run/vertical-host';
import { driveOperations, type FlowGraph } from '@canopy/scope-drive/spec/model';
import type { ScopeStub } from '@substrat-run/kernel';
import { assistantAccess, mountAssistantMcp, type AssistantDirectory, type SpaceInvoker } from './assistant-mcp';
import { mountFlows, type FlowAccess, type FlowScope, type FlowSite, type FlowStore } from './flow-routes';
import type { DirectoryFlow, FlowScopes } from './flow-directory';

const graph = (over: Partial<FlowGraph> = {}): FlowGraph => ({
  versions: 'first',
  nodes: [
    { id: 't', type: 'trigger', on: 'arrived', spaces: ['bank'] },
    { id: 'copy', type: 'copy', space: 'a3docs', folderId: 'bancos', alsoIn: [] },
  ],
  edges: [{ from: 't', to: 'copy', branch: 'next' }],
  ...over,
});

const stored = (id: string, scopes: FlowScopes, over: Partial<DirectoryFlow> = {}) => ({
  flow: { id, name: id, enabled: true, graph: graph(), author: 'Ada', authorSub: 'ada', createdAt: 'c', updatedAt: 'u', failures: 0, pausedReason: null, ...over } satisfies DirectoryFlow,
  scopes,
});

/** A space's stub that answers by operation; anything else is a test failure. */
type Answer = unknown | ((input: unknown) => unknown);
function scope(answers: Record<string, Answer>): SpaceInvoker & { invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async (op: string, input?: unknown) => {
    if (!(op in answers)) throw new Error(`unexpected ${op}`);
    const answer = answers[op];
    return typeof answer === 'function' ? (answer as (i: unknown) => unknown)(input) : answer;
  });
  return { invoke } as SpaceInvoker & { invoke: typeof invoke };
}

/**
 * Ada signs in to an install with six spaces. She owns `home` (plain storage), `bank` (a Qonto
 * mirror) and `a3docs` (a3doc), and is a viewer in `shared`. She is not a member of `secret` at all,
 * and `gone` was deleted after she joined it.
 */
function harness(opts: { flows?: ReturnType<typeof stored>[]; signedIn?: boolean } = {}) {
  const bank = scope({
    'drive/people-access': { canManage: true },
    'drive/get-folder': { id: 'root', canWrite: true },
    'drive/get-source': { source: { provider: 'canopy.qonto', canUpload: false } },
    'drive/list-plugins': { plugins: [{ id: 'qonto-view' }] },
    'drive/flow-candidates': { files: [], next: null },
  });
  const a3docs = scope({
    'drive/people-access': { canManage: true },
    'drive/get-source': { source: { provider: 'canopy.a3doc', canUpload: true } },
    'drive/get-folder': (input: unknown) => {
      const id = (input as { folderId: string }).folderId;
      if (id === 'bancos' || id === 'root') return { id, canWrite: true };
      if (id === 'read-only') return { id, canWrite: false };
      throw new Error('not_found');
    },
    'drive/list-folders': (input: unknown) => {
      const { folderId, cursor } = input as { folderId: string; cursor?: string };
      if (folderId === 'root' && !cursor) return { entries: [{ id: 'bancos', name: 'Bancos' }], nextCursor: 'p2' };
      if (folderId === 'root') return { entries: [{ id: 'facturas', name: 'Facturas' }], nextCursor: null };
      if (folderId === 'bancos') return { entries: [{ id: 'y2026', name: '2026' }], nextCursor: null };
      return { entries: [], nextCursor: null };
    },
    'drive/flow-deliveries': { deliveries: [] },
  });
  const shared = scope({ 'drive/people-access': { canManage: false }, 'drive/get-folder': { id: 'root', canWrite: false }, 'drive/get-source': { source: null } });
  const home = scope({
    'drive/people-access': { canManage: true }, 'drive/get-folder': { id: 'root', canWrite: true },
    'drive/get-source': { source: null }, 'drive/list-plugins': { plugins: [] },
  });
  const secret = scope({ 'drive/list-folders': { entries: [{ id: 'payroll', name: 'Payroll' }], nextCursor: null }, 'drive/list-plugins': { plugins: [] } });

  // The flow routes, as the worker mounts them off the public table.
  const flowSites: FlowSite[] = [
    { slug: 'bank', name: 'Bank', scopeId: 's-bank', scope: bank as FlowScope, manages: true },
    { slug: 'a3docs', name: 'Gestoría', scopeId: 's-a3', scope: a3docs as FlowScope, manages: true },
    { slug: 'shared', name: 'Shared', scopeId: 's-shared', scope: shared as FlowScope, manages: false },
  ];
  const flows = opts.flows ?? [];
  const store: FlowStore = {
    list: vi.fn(async () => flows),
    save: vi.fn(async (input) => ({ ...input, createdAt: input.now, updatedAt: input.now, failures: 0, pausedReason: null })),
    delete: vi.fn(async () => {}),
  };
  const start = vi.fn(async () => {});
  const flowAccess: FlowAccess = { sub: 'ada', author: 'Ada', tenantId: 't', sites: async () => flowSites, store, newId: () => 'new-id', now: () => 'now', start };
  const flowRoutes = new Hono();
  flowRoutes.onError((err, c) => problemResponse(c, err));
  mountFlows(flowRoutes, async () => flowAccess);

  // The tenant's registry and directory: who is bound where, and each space as a principal.
  const registry = [
    { slug: 'home', name: 'Home', scopeId: 's-home' },
    { slug: 'bank', name: 'Bank', scopeId: 's-bank' },
    { slug: 'a3docs', name: 'a3docs', scopeId: 's-a3' },
    { slug: 'shared', name: 'Shared', scopeId: 's-shared' },
    { slug: 'secret', name: 'Secret', scopeId: 's-secret' },
    { slug: 'gone', name: 'Gone', scopeId: 's-gone' },
  ];
  const stubs: Record<string, SpaceInvoker> = { 's-home': home, 's-bank': bank, 's-a3': a3docs, 's-shared': shared, 's-secret': secret };
  const bound: Record<string, string> = { 's-home': 'p-home', 's-bank': 'p-bank', 's-a3': 'p-a3', 's-shared': 'p-shared', 's-gone': 'p-gone' };
  const directory: AssistantDirectory = {
    listSites: async () => registry,
    resolveSiteScope: async (slug) => registry.find((s) => s.slug === slug)?.scopeId ?? null,
    principalIn: vi.fn(async (scopeId: string, sub: string) => (sub === 'ada' ? bound[scopeId] ?? null : null)),
    settings: async (scopeId) => (scopeId === 's-bank' ? { categories: [{ id: 'statement', name: 'Statement' }] } : scopeId === 's-a3' ? { name: 'Gestoría' } : null),
    scopeAs: vi.fn(async (_principal: string, scopeId: string) => {
      const stub = stubs[scopeId];
      if (!stub) throw new Error('scope is not active');
      return stub;
    }),
  };
  const access = assistantAccess(directory, 'ada', async (method, path, body) =>
    flowRoutes.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));

  const app = new Hono();
  mountAssistantMcp(app, driveOperations, async () => {
    if (opts.signedIn === false) throw new HTTPException(401, { message: 'unauthorized' });
    return { access, ids: { tenantId: 't', scopeId: 's-home' } as unknown as Pick<ScopeStub, 'tenantId' | 'scopeId'> };
  });

  let id = 0;
  const rpc = (method: string, params?: unknown) =>
    app.request('/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  /** A tool call: what the model reads back, and whether it was refused. */
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await rpc('tools/call', { name, arguments: args });
    const body = await res.json() as { result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    const text = body.result!.content[0]!.text;
    return { isError: body.result!.isError === true, text, value: body.result!.isError ? null : JSON.parse(text) };
  };
  return { rpc, tool, store, start, bank, a3docs, shared, home, secret, directory };
}

describe('the assistant MCP endpoint', () => {
  it('lists the flow and space tools beside the drive tools, each drive tool taking a space', async () => {
    const res = await harness().rpc('tools/list');
    const { result } = await res.json() as { result: { tools: { name: string; description: string; inputSchema: { properties: Record<string, { properties?: Record<string, unknown> }>; required?: string[] } }[] } };
    const byName = new Map(result.tools.map((t) => [t.name, t]));
    for (const name of ['drive_list-spaces', 'drive_list-space-folders', 'drive_list-flows', 'drive_get-flow', 'drive_save-flow', 'drive_remove-flow', 'drive_preview-flow', 'drive_run-flow', 'drive_list-flow-deliveries', 'drive_decide-flow-delivery']) {
      expect(byName.has(name), name).toBe(true);
    }
    // The save tool's schema is the shared `flowSaveInput`, rendered: the model sees every node type.
    const save = byName.get('drive_save-flow')!;
    expect(Object.keys(save.inputSchema.properties)).toEqual(expect.arrayContaining(['name', 'enabled', 'graph']));
    expect(JSON.stringify(save.inputSchema)).toContain('"trigger"');
    expect(save.description).toContain('trigger');
    // Every drive tool, with or without its own input, must name the space it acts in.
    const driveTools = result.tools.filter((t) => !['drive_list-spaces', 'drive_list-flows'].includes(t.name) && !t.name.includes('flow'));
    expect(driveTools.length).toBeGreaterThan(40);
    for (const t of driveTools) expect(t.inputSchema.required ?? [], t.name).toContain('space');
  });

  it('answers 401 with a challenge when nobody is signed in, so the client starts its sign-in', async () => {
    const res = await harness({ signedIn: false }).rpc('tools/list');
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('resource_metadata');
  });
});

describe('reaching a space', () => {
  it('lists every space the login is a member of, with its role, kind and whether it is read-only', async () => {
    const { value } = await harness().tool('drive_list-spaces');
    expect(value.spaces).toEqual([
      { slug: 'home', name: 'Home', role: 'owner', kind: 'storage', source: null, readOnly: false, categories: [] },
      { slug: 'bank', name: 'Bank', role: 'owner', kind: 'qonto', source: { provider: 'canopy.qonto', canUpload: false }, readOnly: true, categories: [{ id: 'statement', name: 'Statement' }] },
      { slug: 'a3docs', name: 'Gestoría', role: 'owner', kind: 'a3doc', source: { provider: 'canopy.a3doc', canUpload: true }, readOnly: false, categories: [] },
      { slug: 'shared', name: 'Shared', role: 'viewer', kind: 'storage', source: null, readOnly: true, categories: [] },
    ]);
  });

  it('sends a drive tool to the space it names, as the caller there, without the space argument', async () => {
    const h = harness();
    expect((await h.tool('drive_list-plugins', { space: 'bank' })).value).toEqual({ plugins: [{ id: 'qonto-view' }] });
    expect(h.bank.invoke).toHaveBeenCalledWith('drive/list-plugins', {}, expect.anything());
    expect(h.directory.scopeAs).toHaveBeenCalledWith('p-bank', 's-bank');
    // An operation that takes no input gets none, as over HTTP.
    expect((await h.tool('drive_get-source', { space: 'a3docs' })).value).toEqual({ source: { provider: 'canopy.a3doc', canUpload: true } });
    expect(h.a3docs.invoke).toHaveBeenCalledWith('drive/get-source', undefined, expect.anything());
  });

  it('works across spaces in one connection: no space is bound, and none is assumed', async () => {
    const h = harness();
    expect((await h.tool('drive_list-plugins', { space: 'home' })).value).toEqual({ plugins: [] });
    expect((await h.tool('drive_list-plugins', { space: 'bank' })).value).toEqual({ plugins: [{ id: 'qonto-view' }] });
    const unnamed = await h.tool('drive_get-source');
    expect(unnamed.isError).toBe(true);
    expect(unnamed.text).toContain('Say which space to act in');
    expect(h.home.invoke).not.toHaveBeenCalledWith('drive/get-source', expect.anything(), expect.anything());
  });

  it('never reaches a space the login is not a member of, whatever slug it names', async () => {
    const h = harness();
    // Not listed…
    expect((await h.tool('drive_list-spaces')).value.spaces.map((s: { slug: string }) => s.slug)).not.toContain('secret');
    // …and not reachable by naming it, through a drive tool or a space tool.
    for (const [name, args] of [
      ['drive_list-folders', { space: 'secret', folderId: 'root' }],
      ['drive_list-plugins', { space: 'secret' }],
      ['drive_list-space-folders', { space: 'secret' }],
    ] as const) {
      const refused = await h.tool(name, args);
      expect(refused.isError, name).toBe(true);
      expect(refused.text).toMatch(/no space 'secret' that you can open.*drive_list-spaces/);
    }
    // Refused before any stub exists for it: the directory said no, so the scope was never asked.
    expect(h.directory.scopeAs).not.toHaveBeenCalledWith(expect.anything(), 's-secret');
    expect(h.secret.invoke).not.toHaveBeenCalled();
    // A slug that does not exist reads the same, so a refusal says nothing about what exists.
    expect((await h.tool('drive_list-plugins', { space: 'nowhere' })).text).toBe((await h.tool('drive_list-plugins', { space: 'secret' })).text.replace('secret', 'nowhere'));
  });

  it('cannot use a space it is not a member of in a flow', async () => {
    const h = harness();
    const refused = await h.tool('drive_save-flow', { name: 'Exfiltrate', enabled: true, graph: graph({
      nodes: [
        { id: 't', type: 'trigger', on: 'arrived', spaces: ['secret'] },
        { id: 'copy', type: 'copy', space: 'a3docs', folderId: 'bancos', alsoIn: [] },
      ],
    }) });
    expect(refused).toMatchObject({ isError: true, text: "Only someone who owns the space 'secret' can use it in a flow." });
    expect(h.store.save).not.toHaveBeenCalled();
  });

  it('leaves out a space that no longer opens, and refuses it by name', async () => {
    const h = harness();
    expect((await h.tool('drive_list-spaces')).value.spaces.map((s: { slug: string }) => s.slug)).not.toContain('gone');
    expect(await h.tool('drive_list-plugins', { space: 'gone' })).toMatchObject({ isError: true });
  });

  it('lists every folder of a space by path, across pages and levels', async () => {
    const { value } = await harness().tool('drive_list-space-folders', { space: 'a3docs' });
    expect(value).toEqual({
      space: 'a3docs',
      folders: [{ id: 'root', path: '' }, { id: 'bancos', path: 'Bancos' }, { id: 'y2026', path: 'Bancos/2026' }, { id: 'facturas', path: 'Facturas' }],
      truncated: false,
    });
    const capped = await harness().tool('drive_list-space-folders', { space: 'a3docs', limit: 2 });
    expect(capped.value.folders).toHaveLength(2);
    expect(capped.value.truncated).toBe(true);
  });
});

describe('flows over MCP', () => {
  it('saves a flow as the signed-in login, through the same checks as the app', async () => {
    const h = harness();
    const saved = await h.tool('drive_save-flow', { name: 'Statements', enabled: true, graph: graph() });
    expect(saved.isError).toBe(false);
    expect(saved.value).toMatchObject({ id: 'new-id', name: 'Statements', spaces: [{ slug: 'bank', watch: true, write: false }, { slug: 'a3docs', watch: false, write: true }] });
    expect(h.store.save).toHaveBeenCalledWith(expect.objectContaining({ authorSub: 'ada', scopes: { watch: ['s-bank'], write: ['s-a3'] } }), true);
  });

  it('refuses a flow that names a space the caller does not own', async () => {
    const h = harness();
    const refused = await h.tool('drive_save-flow', { name: 'Leak', enabled: true, graph: graph({
      nodes: [
        { id: 't', type: 'trigger', on: 'arrived', spaces: ['bank'] },
        { id: 'copy', type: 'copy', space: 'shared', folderId: 'x', alsoIn: [] },
      ],
    }) });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe("Only someone who owns the space 'shared' can use it in a flow.");
    expect(h.store.save).not.toHaveBeenCalled();
  });

  it('refuses a copy into a folder the caller cannot add files to', async () => {
    const h = harness();
    const refused = await h.tool('drive_save-flow', { name: 'Statements', enabled: true, graph: graph({
      nodes: [
        { id: 't', type: 'trigger', on: 'arrived', spaces: ['bank'] },
        { id: 'copy', type: 'copy', space: 'a3docs', folderId: 'read-only', alsoIn: [] },
      ],
    }) });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('not one you can add files to');
    expect(h.store.save).not.toHaveBeenCalled();
  });

  it('refuses an incomplete flow with what is missing, from the shared schema', async () => {
    const h = harness();
    const noAction = await h.tool('drive_save-flow', { name: 'Nothing', enabled: true, graph: {
      versions: 'first', nodes: [{ id: 't', type: 'trigger', on: 'arrived', spaces: ['bank'] }], edges: [],
    } });
    expect(noAction.isError).toBe(true);
    expect(noAction.text).toMatch(/^This flow isn't complete: /);
    const noName = await h.tool('drive_save-flow', { enabled: true, graph: graph() });
    expect(noName.isError).toBe(true);
    expect(noName.text).toMatch(/^This flow isn't complete: /);
    expect(h.store.save).not.toHaveBeenCalled();
  });

  it('only lists and reads flows whose every space the caller owns', async () => {
    const h = harness({ flows: [stored('mine', { watch: ['s-bank'], write: ['s-a3'] }), stored('theirs', { watch: ['s-bank'], write: ['s-shared'] })] });
    const list = await h.tool('drive_list-flows');
    expect(list.value.flows.map((f: { id: string }) => f.id)).toEqual(['mine']);
    expect((await h.tool('drive_get-flow', { id: 'mine' })).value).toMatchObject({ id: 'mine', graph: graph() });
    const hidden = await h.tool('drive_get-flow', { id: 'theirs' });
    expect(hidden).toMatchObject({ isError: true, text: 'Flow not found.' });
    const notMine = await h.tool('drive_remove-flow', { id: 'theirs' });
    expect(notMine).toMatchObject({ isError: true, text: 'Flow not found.' });
    expect(h.store.delete).not.toHaveBeenCalled();
  });

  it('runs a switched-on flow over each space it watches, and refuses one that is off', async () => {
    const h = harness({ flows: [stored('on', { watch: ['s-bank'], write: ['s-a3'] }), stored('off', { watch: ['s-bank'], write: ['s-a3'] }, { enabled: false })] });
    expect((await h.tool('drive_run-flow', { id: 'on' })).value).toEqual({ started: true });
    expect(h.start).toHaveBeenCalledWith('s-bank', expect.any(String), 'on', expect.objectContaining({ flowId: 'on' }));
    expect(await h.tool('drive_run-flow', { id: 'off' })).toMatchObject({ isError: true, text: 'Turn the flow on before running it.' });
  });

  it('previews an unsaved flow without changing anything', async () => {
    const h = harness();
    const preview = await h.tool('drive_preview-flow', { graph: graph() });
    expect(preview.value).toMatchObject({ matched: 0, scanned: 0, truncated: false });
    expect(h.store.save).not.toHaveBeenCalled();
    const elsewhere = await h.tool('drive_preview-flow', { graph: graph({ nodes: [
      { id: 't', type: 'trigger', on: 'arrived', spaces: ['shared'] },
      { id: 'copy', type: 'copy', space: 'a3docs', folderId: 'bancos', alsoIn: [] },
    ] }) });
    expect(elsewhere).toMatchObject({ isError: true, text: "Only someone who owns the space 'shared' can use it in a flow." });
  });
});
