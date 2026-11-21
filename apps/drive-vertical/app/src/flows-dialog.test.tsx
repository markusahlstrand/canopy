import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FlowsDialog } from './flows-dialog';
import { FileAutomation } from './file-automation';
import { categoryIdFor } from './categories-editor';
import { addStep, connect, describeFlow, describeStep, newGraph, removeSteps, type Names } from './flow-graph-edit';
import type { DeliveryView, FileDetails, FlowGraph, FlowView } from './api';

/**
 * React Flow measures its nodes before it shows them, and jsdom measures nothing: these stand in
 * so the canvas draws (the stubs React Flow's own testing guide gives).
 */
beforeAll(() => {
  class MeasuringResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) { this.callback([{ target, contentRect: { width: 100, height: 100 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver); }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = MeasuringResizeObserver as unknown as typeof ResizeObserver;
  (globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly = class { m22 = 1; constructor(_t?: string) {} };
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: { configurable: true, get() { return parseFloat((this as HTMLElement).style.height) || 1; } },
    offsetWidth: { configurable: true, get() { return parseFloat((this as HTMLElement).style.width) || 1; } },
  });
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const owned = [{ slug: 'bank', name: 'Bank' }, { slug: 'receipts', name: 'Receipts' }, { slug: 'gestoria', name: 'Gestoría' }];
const categories = [{ id: 'bank-statement', name: 'Bank statement' }];

const graph: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', on: 'arrived', spaces: ['bank'], position: { x: 0, y: 0 } },
    { id: 'check-1', type: 'check', condition: { field: 'extension', values: ['pdf'] }, position: { x: 300, y: 0 } },
    { id: 'approval-1', type: 'approval', position: { x: 600, y: 0 } },
    { id: 'copy-1', type: 'copy', space: 'gestoria', folderId: 'bancos', alsoIn: [], position: { x: 900, y: 0 } },
  ],
  edges: [
    { from: 'trigger', to: 'check-1', branch: 'next' },
    { from: 'check-1', to: 'approval-1', branch: 'yes' },
    { from: 'approval-1', to: 'copy-1', branch: 'next' },
  ],
  versions: 'first',
};
const flow = (over: Partial<FlowView> = {}): FlowView => ({
  id: 'f1', name: 'Statements', enabled: true, graph, author: 'p', createdAt: '', updatedAt: '', failures: 0, pausedReason: null,
  spaces: [{ slug: 'bank', name: 'Bank', watch: true, write: false }, { slug: 'gestoria', name: 'Gestoría', watch: false, write: true }],
  ...over,
});
const receiptsFlow = flow({
  id: 'f2', name: 'Receipts labelled',
  graph: {
    nodes: [{ id: 'trigger', type: 'trigger', on: 'schedule', every: 'day', spaces: ['receipts'] }, { id: 'label-1', type: 'label', value: 'review' }],
    edges: [{ from: 'trigger', to: 'label-1', branch: 'next' }], versions: 'first',
  },
  spaces: [{ slug: 'receipts', name: 'Receipts', watch: true, write: true }],
});
const delivery = (over: Partial<DeliveryView>): DeliveryView => ({
  space: 'bank', flowId: 'f1', flowName: 'Statements', fileId: 'file', versionId: 'v1', fileName: 'Statement.pdf',
  state: 'proposed', detail: {}, attempts: 0, createdAt: '', updatedAt: '', ...over,
});

function server(options: { flows?: FlowView[]; deliveries?: DeliveryView[]; preview?: unknown } = {}) {
  const calls: { url: string; method: string; body?: unknown; site?: string }[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const site = (init?.headers as Record<string, string> | undefined)?.['x-site'];
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined, site });
    const path = new URL(url, 'http://x').pathname;
    if (path.endsWith('/flows') && method === 'GET') return Response.json({ flows: options.flows ?? [], spaces: owned });
    if (path.endsWith('/flows') && method === 'PUT') return Response.json({ ...flow(), ...(JSON.parse(String(init!.body)) as object), id: 'f1' });
    if (path.endsWith('/flow-deliveries')) return Response.json({ deliveries: options.deliveries ?? [] });
    if (path.endsWith('/flows/preview')) return Response.json(options.preview ?? { matches: [], matched: 0, uncertain: 0, scanned: 0, truncated: false, reach: {}, maybe: {} });
    if (path.endsWith('/flows/f1/run')) return Response.json({ started: true }, { status: 202 });
    if (path.endsWith('/flow-deliveries/decide')) return Response.json({ state: 'approved' });
    if (path.endsWith('/space-settings')) return Response.json({ name: site ?? 's', icon: 'folder', color: '#3b82f6', categories });
    if (path.includes('/folders/root/folders')) return Response.json([{ id: 'bancos', name: 'Bancos', parent_id: 'root', path: 'Bancos' }]);
    if (path.includes('/folders/')) return Response.json([]);
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  return calls;
}

/** A step on the canvas, by what its card says. */
const step = (text: string | RegExp) => {
  const cards = screen.getAllByText(text).map((el) => el.closest<HTMLElement>('.react-flow__node')).filter((el): el is HTMLElement => Boolean(el));
  expect(cards).toHaveLength(1);
  return cards[0]!;
};

describe('the flows workspace', () => {
  it('lists flows with the spaces they watch and copy into, and filters by space', async () => {
    server({ flows: [flow(), receiptsFlow] });
    render(<FlowsDialog open onOpenChange={() => {}} />);
    const list = await screen.findByRole('region', { name: 'Flows' });
    const tags = within(list).getByRole('list', { name: 'Spaces Statements uses' });
    expect(tags.textContent).toContain('Bank · watches');
    expect(tags.textContent).toContain('Gestoría · copies in');
    expect(within(list).getByText('When a document arrives in Bank: copy to Gestoría, after you approve.')).toBeTruthy();
    // A schedule covers what is there already: no button to run it on that.
    expect(within(list).getAllByRole('button', { name: 'Run on documents already there' })).toHaveLength(1);

    fireEvent.change(screen.getByLabelText('Show flows for'), { target: { value: 'receipts' } });
    expect(within(list).queryByText('Statements')).toBeNull();
    expect(within(list).getByText('Receipts labelled')).toBeTruthy();
  });

  it('starts filtered to the space it was opened from', async () => {
    server({ flows: [flow(), receiptsFlow] });
    render(<FlowsDialog open onOpenChange={() => {}} space="receipts" />);
    const list = await screen.findByRole('region', { name: 'Flows' });
    expect(within(list).getByText('Receipts labelled')).toBeTruthy();
    expect(within(list).queryByText('Statements')).toBeNull();
    expect((screen.getByLabelText('Show flows for') as HTMLSelectElement).value).toBe('receipts');
  });

  it('draws a new flow step by step, and saves its graph', async () => {
    const calls = server();
    render(<FlowsDialog open onOpenChange={() => {}} space="bank" />);
    fireEvent.click(await screen.findByRole('button', { name: /New flow/ }));
    fireEvent.change(screen.getByLabelText('Flow name'), { target: { value: 'To the gestoría' } });

    // The trigger starts watching the space the workspace was opened from.
    fireEvent.click(step('When a document arrives in Bank'));
    expect(screen.getByRole('checkbox', { name: 'Watch Bank' }).getAttribute('data-state')).toBe('checked');

    // Each new step joins the selected one: the trigger, then the check's Yes.
    fireEvent.click(screen.getByRole('button', { name: 'Add a check' }));
    expect(screen.getByLabelText('What to check')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('File types'), { target: { value: 'pdf, xml' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a copy' }));
    fireEvent.change(screen.getByLabelText('Space to copy to'), { target: { value: 'gestoria' } });
    const folder = await screen.findByLabelText('Folder to copy to');
    await waitFor(() => expect(within(folder).getByRole('option', { name: 'Bancos' })).toBeTruthy());
    fireEvent.change(folder, { target: { value: 'bancos' } });
    await waitFor(() => step('Copy to Gestoría › Bancos'));
    expect(step('Is it a PDF or XML?')).toBeTruthy();

    // A label after the copy, then moved to the check's No exit from the inspector.
    fireEvent.click(screen.getByRole('button', { name: 'Add a label' }));
    fireEvent.change(screen.getByLabelText('Label to add'), { target: { value: 'review' } });
    fireEvent.click(step('Copy to Gestoría › Bancos'));
    expect((screen.getByLabelText('Then go to') as HTMLSelectElement).value).toBe('label-1');
    fireEvent.change(screen.getByLabelText('Then go to'), { target: { value: '' } });
    fireEvent.click(step('Is it a PDF or XML?'));
    fireEvent.change(screen.getByLabelText('If no, go to'), { target: { value: 'label-1' } });

    const save = screen.getByRole('button', { name: 'Save flow' }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await screen.findByText('Flow saved.');
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toMatchObject({
      name: 'To the gestoría', enabled: true,
      graph: {
        versions: 'first',
        nodes: [
          { id: 'trigger', type: 'trigger', on: 'arrived', spaces: ['bank'] },
          { id: 'check-1', type: 'check', condition: { field: 'extension', values: ['pdf', 'xml'] } },
          { id: 'copy-1', type: 'copy', space: 'gestoria', folderId: 'bancos', alsoIn: [] },
          { id: 'label-1', type: 'label', value: 'review' },
        ],
        edges: [
          { from: 'trigger', to: 'check-1', branch: 'next' },
          { from: 'check-1', to: 'copy-1', branch: 'yes' },
          { from: 'check-1', to: 'label-1', branch: 'no' },
        ],
      },
    });
    // Where each step sits is saved with it.
    expect((put.body as { graph: FlowGraph }).graph.nodes.every((n) => n.position)).toBe(true);
  });

  it('says what stops a flow from saving, on the steps and in a list', async () => {
    server();
    render(<FlowsDialog open onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /New flow/ }));
    expect((screen.getByRole('button', { name: 'Save flow' }) as HTMLButtonElement).disabled).toBe(true);
    const todo = screen.getByRole('region', { name: 'What still needs doing' });
    expect(within(todo).getByText('Give the flow a name.')).toBeTruthy();
    expect(within(todo).getByText('A flow needs at least one action: copy or label.')).toBeTruthy();
    // ...and on the trigger's card itself.
    expect(within(step('When a document arrives in no space yet')).getByText('Connect the trigger to the first step.')).toBeTruthy();

    // Clicking a problem selects its step.
    fireEvent.click(within(todo).getByRole('button', { name: 'Choose at least one space to watch.' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Watch Receipts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a label' }));
    fireEvent.change(screen.getByLabelText('Label to add'), { target: { value: 'seen' } });
    fireEvent.change(screen.getByLabelText('Flow name'), { target: { value: 'Seen' } });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'What still needs doing' })).toBeNull());
    expect((screen.getByRole('button', { name: 'Save flow' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows how many documents reach each step, which ones, and runs on them when saved', async () => {
    const calls = server({
      flows: [flow()],
      preview: {
        matches: [
          { space: 'bank', fileId: 'a', name: 'Statement-01.pdf', folderPath: 'Statements', category: 'bank-statement', needsAnswer: false, handled: false },
          { space: 'bank', fileId: 'b', name: 'Statement-02.pdf', folderPath: 'Statements', category: null, needsAnswer: false, handled: true },
          { space: 'bank', fileId: 'c', name: 'Maybe.pdf', folderPath: '', category: null, needsAnswer: true, handled: false },
        ],
        matched: 3, uncertain: 1, scanned: 40, truncated: false,
        reach: { trigger: 40, 'check-1': 40, 'approval-1': 2, 'copy-1': 2 }, maybe: { 'approval-1': 1, 'copy-1': 1 },
      },
    });
    render(<FlowsDialog open onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Statements' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show what it matches' }));
    const preview = screen.getByRole('region', { name: 'Documents it matches now' });
    await within(preview).findByText(/3 documents match\./);
    expect(calls.find((c) => c.url.endsWith('/flows/preview'))!.body).toEqual({ id: 'f1', graph });
    expect(within(preview).getByText('Bank › Statements · Bank statement')).toBeTruthy();
    expect(within(preview).getByText('Already done')).toBeTruthy();
    expect(within(preview).getByText('If AI says yes')).toBeTruthy();
    // The counts sit on the steps they belong to.
    expect(within(step('Copy to Gestoría › Bancos')).getByLabelText('2 documents, 1 more maybe')).toBeTruthy();

    // Changing what the flow does makes the result stale; changing it back makes it fresh again.
    fireEvent.click(step('Is it a PDF?'));
    fireEvent.change(screen.getByLabelText('File types'), { target: { value: 'xml' } });
    expect(within(preview).getByText('The flow changed since the last check.')).toBeTruthy();
    expect(within(step('Copy to Gestoría › Bancos')).queryByLabelText(/documents/)).toBeNull();
    fireEvent.change(screen.getByLabelText('File types'), { target: { value: 'pdf' } });

    fireEvent.click(within(preview).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Save flow' }));
    await screen.findByText(/Waiting for you/);
    expect(calls.some((c) => c.url.endsWith('/flows/f1/run') && c.method === 'POST')).toBe(true);
  });

  it('asks again before running on what is there once the flow changes', async () => {
    const calls = server({
      flows: [flow()],
      preview: { matches: [{ space: 'bank', fileId: 'a', name: 'S.pdf', folderPath: 'Statements', category: null, needsAnswer: false, handled: false }], matched: 1, uncertain: 0, scanned: 1, truncated: false, reach: {}, maybe: {} },
    });
    render(<FlowsDialog open onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Statements' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show what it matches' }));
    const preview = screen.getByRole('region', { name: 'Documents it matches now' });
    await within(preview).findByText('1 document matches.');
    fireEvent.click(within(preview).getByRole('checkbox'));
    fireEvent.click(step('Is it a PDF?'));
    fireEvent.change(screen.getByLabelText('File types'), { target: { value: 'xml' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save flow' }));
    await screen.findByText('Flow saved.');
    expect(calls.some((c) => c.url.endsWith('/run'))).toBe(false);
  });

  it('lays out a flow that has no positions yet, without counting that as a change', async () => {
    const calls = server({ flows: [receiptsFlow] });
    render(<FlowsDialog open onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Receipts labelled' }));
    // Laid out left to right: the label sits right of the trigger.
    const x = (text: string) => Number(/translate\((-?[\d.]+)px/.exec(step(text).style.transform)?.[1]);
    await waitFor(() => expect(x('Add label ‘review’')).toBeGreaterThan(x('Every day, for what arrived in Receipts')));
    // Closing asks nothing: the layout is where the flow starts, not an edit.
    const confirm = vi.spyOn(window, 'confirm');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Receipts labelled' }));
    await waitFor(() => expect(x('Add label ‘review’')).toBeGreaterThan(x('Every day, for what arrived in Receipts')));
    fireEvent.click(screen.getByRole('button', { name: 'Save flow' }));
    await screen.findByText('Flow saved.');
    const saved = (calls.find((c) => c.method === 'PUT')!.body as { graph: FlowGraph }).graph;
    expect(saved.nodes.every((n) => n.position)).toBe(true);
  });

  it('approves, dismisses and retries, naming the space of each document', async () => {
    const calls = server({
      flows: [flow()],
      deliveries: [
        delivery({}),
        delivery({ fileId: 'other', fileName: 'Other.pdf', space: 'receipts' }),
        delivery({ fileId: 'broken', fileName: 'Broken.pdf', state: 'failed', detail: { error: 'a3doc said no' } }),
      ],
    });
    render(<FlowsDialog open onOpenChange={() => {}} />);
    const waiting = await screen.findByRole('region', { name: 'Waiting for approval' });
    expect(within(waiting).getByText('Bank · Statements')).toBeTruthy();
    expect(within(waiting).getByText('Receipts · Statements')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Recent activity' })).getByText('Bank · Statements: a3doc said no')).toBeTruthy();

    fireEvent.click(within(waiting).getAllByRole('button', { name: 'Approve' })[0]!);
    await screen.findByText('Approved. It runs in a moment.');
    fireEvent.click(within(screen.getByRole('region', { name: 'Waiting for approval' })).getAllByRole('button', { name: 'Dismiss' })[1]!);
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/decide'))).toHaveLength(2));
    await waitFor(() => expect((within(screen.getByRole('region', { name: 'Recent activity' })).getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(screen.getByRole('region', { name: 'Recent activity' })).getByRole('button', { name: 'Retry' }));
    await screen.findByText('Trying again.');
    expect(calls.filter((c) => c.url.includes('/decide')).map((c) => c.body)).toEqual([
      { space: 'bank', flowId: 'f1', fileId: 'file', versionId: 'v1', decision: 'approve' },
      { space: 'receipts', flowId: 'f1', fileId: 'other', versionId: 'v1', decision: 'dismiss' },
      { space: 'bank', flowId: 'f1', fileId: 'broken', versionId: 'v1', decision: 'retry' },
    ]);
  });

  it('looks for new proposals while the list is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const calls = server({ flows: [flow()] });
      render(<FlowsDialog open onOpenChange={() => {}} />);
      await screen.findByRole('region', { name: 'Flows' });
      const before = calls.filter((c) => c.url.includes('/flow-deliveries')).length;
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(calls.filter((c) => c.url.includes('/flow-deliveries')).length).toBeGreaterThan(before);
    } finally { vi.useRealTimers(); }
  });
});

describe('editing a graph', () => {
  const names: Names = {
    space: (s) => owned.find((o) => o.slug === s)?.name ?? s,
    category: (id) => categories.find((c) => c.id === id)?.name ?? id,
    folder: (_s, id) => (id === 'bancos' ? 'Bancos' : undefined),
  };

  it('joins a new step to the first free exit of the selected one', () => {
    let g = newGraph(['bank']);
    g = addStep(g, 'check', 'trigger').graph;
    expect(g.edges).toEqual([{ from: 'trigger', to: 'check-1', branch: 'next' }]);
    g = addStep(g, 'copy', 'check-1').graph;
    g = addStep(g, 'label', 'check-1').graph;
    expect(g.edges.slice(1)).toEqual([{ from: 'check-1', to: 'copy-1', branch: 'yes' }, { from: 'check-1', to: 'label-1', branch: 'no' }]);
    // Both exits taken: the next one stands alone.
    expect(addStep(g, 'approval', 'check-1').graph.edges).toHaveLength(3);
  });

  it('with nothing selected, joins a new step to the newest one with a free exit', () => {
    let g = addStep(newGraph(['bank']), 'check').graph;
    g = addStep(g, 'copy').graph;
    g = addStep(g, 'label').graph;
    expect(g.edges).toEqual([
      { from: 'trigger', to: 'check-1', branch: 'next' },
      { from: 'check-1', to: 'copy-1', branch: 'yes' },
      { from: 'copy-1', to: 'label-1', branch: 'next' },
    ]);
  });

  it('keeps one connection per exit, and never one into the trigger', () => {
    let g = addStep(addStep(newGraph(['bank']), 'label').graph, 'approval').graph;
    g = { ...g, edges: [] };
    g = connect(g, 'trigger', 'next', 'label-1');
    g = connect(g, 'trigger', 'next', 'approval-1');
    expect(g.edges).toEqual([{ from: 'trigger', to: 'approval-1', branch: 'next' }]);
    expect(connect(g, 'approval-1', 'next', 'trigger')).toBe(g);
    expect(connect(g, 'approval-1', 'yes', 'label-1')).toBe(g);
    expect(connect(g, 'label-1', 'next', 'label-1')).toBe(g);
  });

  it('removes steps with their connections, but never the trigger', () => {
    const g = removeSteps(graph, ['approval-1', 'trigger']);
    expect(g.nodes.map((n) => n.id)).toEqual(['trigger', 'check-1', 'copy-1']);
    expect(g.edges).toEqual([{ from: 'trigger', to: 'check-1', branch: 'next' }]);
  });

  it('says what each step does in plain words', () => {
    const say = (n: FlowGraph['nodes'][number]) => describeStep(n, names);
    expect(say({ id: 't', type: 'trigger', on: 'arrived', spaces: ['bank', 'receipts'] })).toBe('When a document arrives in Bank, Receipts');
    expect(say({ id: 't', type: 'trigger', on: 'schedule', every: 'week', spaces: ['bank'] })).toBe('Every week, for what arrived in Bank');
    expect(say({ id: 'c', type: 'check', condition: { field: 'extension', values: ['pdf'] } })).toBe('Is it a PDF?');
    expect(say({ id: 'c', type: 'check', condition: { field: 'category', values: ['bank-statement'], minConfidence: 0.7 } })).toBe('Is it a Bank statement?');
    expect(say({ id: 'a', type: 'approval' })).toBe('Wait for your approval');
    expect(say({ id: 'p', type: 'copy', space: 'gestoria', folderId: 'bancos', alsoIn: [] })).toBe('Copy to Gestoría › Bancos');
    expect(say({ id: 'l', type: 'label', value: 'review' })).toBe('Add label ‘review’');
    expect(describeFlow(receiptsFlow.graph, names)).toBe('Every day, for what arrived in Receipts: add label ‘review’.');
  });
});

describe('a file’s automation', () => {
  const base: FileDetails = { fileId: 'file', description: '', labels: [], revision: 0, canWrite: true };
  it('shows a failed send to a3doc, and retries it', async () => {
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith('/space-settings') ? Response.json({ name: 's', icon: 'folder', color: '#3b82f6' }) : Response.json({}));
    vi.stubGlobal('fetch', fetcher);
    const changed = vi.fn();
    render(<FileAutomation details={{ ...base, send: { state: 'failed', error: 'a3doc said no', failedAt: null, attempts: 3 } }} onChanged={changed} />);
    expect(screen.getByRole('alert').textContent).toContain('a3doc said no (3 tries)');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith('/files/file/retry-send') && init?.method === 'POST')).toBe(true);
  });

  it('says when the categories could not be loaded, and lets a person try again', async () => {
    let fail = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/space-settings')) return fail ? Response.json({ error: 'down' }, { status: 503 }) : Response.json({ name: 's', icon: 'folder', color: '#3b82f6', categories });
      return Response.json({});
    }));
    render(<FileAutomation details={{ ...base }} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't load");
    expect(screen.queryByText(/no categories yet/)).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(await screen.findByLabelText('Category')).toBeTruthy();
  });

  it('shows the AI’s category and lets a person change it', async () => {
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith('/space-settings')
      ? Response.json({ name: 's', icon: 'folder', color: '#3b82f6', categories: [...categories, { id: 'invoice', name: 'Invoice' }] })
      : Response.json({ changed: true }));
    vi.stubGlobal('fetch', fetcher);
    render(<FileAutomation details={{ ...base, category: { id: 'bank-statement', confidence: 0.92, source: 'ai', versionId: 'v' } }} onChanged={() => {}} />);
    expect(await screen.findByText('Chosen by Document AI, 92% sure.')).toBeTruthy();
    expect(screen.getByText('Bank statement')).toBeTruthy();
    // Nothing is fetched until someone wants to change it.
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.change(await screen.findByLabelText('Category'), { target: { value: 'invoice' } });
    await waitFor(() => expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith('/files/file/category') && JSON.parse(String(init?.body)).category === 'invoice')).toBe(true));
  });
});

it('makes category ids from names, without accents or clashes', () => {
  expect(categoryIdFor('Extracto bancário', [])).toBe('extracto-bancario');
  expect(categoryIdFor('Invoice', ['invoice'])).toBe('invoice-2');
  expect(categoryIdFor('!!!', [])).toBe('category');
});

describe('a flow as raw JSON', () => {
  /** The flow fixture with its copy turned into a label, as someone would type it. */
  const edited = (over: Record<string, unknown> = {}) => ({
    name: 'Renamed', enabled: true,
    graph: { ...graph, nodes: graph.nodes.map((n) => (n.id === 'copy-1' ? { id: 'copy-1', type: 'label', value: 'urgent', position: n.position } : n)) },
    ...over,
  });
  const openRaw = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Statements' }));
    // Radix tabs switch on mouse down.
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Raw JSON/ }));
    return screen.getByLabelText('Flow as JSON') as HTMLTextAreaElement;
  };
  const type = (text: string) => fireEvent.change(screen.getByLabelText('Flow as JSON'), { target: { value: text } });
  const puts = <C extends { method: string }>(calls: C[]) => calls.filter((c) => c.method === 'PUT');

  it('shows what a person may change, and saves an edit only once it passes the save route’s checks', async () => {
    const calls = server({ flows: [flow()] });
    render(<FlowsDialog open onOpenChange={() => {}} />);
    const text = await openRaw();
    expect(JSON.parse(text.value)).toEqual({ name: 'Statements', enabled: true, graph });
    expect(screen.getByText('f1').tagName).toBe('CODE');

    type('{ "name": "Renamed", ');
    fireEvent.click(screen.getByRole('button', { name: 'Save flow' }));
    const problems = screen.getByRole('alert', { name: 'What is wrong with the JSON' });
    expect(problems.textContent).toContain('This isn’t valid JSON');
    expect(text.getAttribute('aria-invalid')).toBe('true');

    type(JSON.stringify(edited({ graph: { ...graph, nodes: [graph.nodes[0]], edges: [] } })));
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(screen.getByRole('alert', { name: 'What is wrong with the JSON' }).textContent).toContain('graph: A flow needs at least one action: copy or label.');
    fireEvent.click(screen.getByRole('button', { name: 'Save flow' }));
    expect(puts(calls)).toHaveLength(0);

    // Fields the server keeps are ignored, and the id is never taken from the text.
    type(JSON.stringify({ ...edited(), id: 'someone-elses', author: 'Eve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(screen.getByRole('status').textContent).toBe('This flow can be saved. Ignored id, author: Canopy keeps those itself.');
    fireEvent.click(screen.getByRole('button', { name: 'Save flow' }));
    await screen.findByText('Flow saved.');
    expect(puts(calls).map((c) => c.body)).toEqual([{ id: 'f1', ...edited() }]);
  });

  it('shows the edited flow on the canvas, and stays on the JSON while it is broken', async () => {
    const calls = server({ flows: [flow()] });
    render(<FlowsDialog open onOpenChange={() => {}} />);
    await openRaw();
    type('not json');
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Canvas/ }));
    expect(screen.getByLabelText('Flow as JSON')).toBeTruthy();
    expect(screen.getByRole('alert', { name: 'What is wrong with the JSON' }).textContent).toContain('This isn’t valid JSON');

    // An unsaved edit is an unsaved edit, in either view.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(confirm).toHaveBeenCalled();

    type(JSON.stringify(edited()));
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Canvas/ }));
    expect(screen.queryByLabelText('Flow as JSON')).toBeNull();
    expect((screen.getByLabelText('Flow name') as HTMLInputElement).value).toBe('Renamed');
    expect(step('Add label ‘urgent’')).toBeTruthy();
    expect(screen.queryByText('Copy to Gestoría › Bancos')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save flow' }));
    await screen.findByText('Flow saved.');
    expect((puts(calls)[0]!.body as { graph: FlowGraph }).graph.nodes.find((n) => n.id === 'copy-1')).toEqual({ id: 'copy-1', type: 'label', value: 'urgent', position: { x: 900, y: 0 } });
  });

  it('never puts a layout for a graph that was replaced on the one that replaced it', async () => {
    const calls = server({ flows: [flow()] });
    render(<FlowsDialog open onOpenChange={() => {}} />);
    await openRaw();
    // A has no positions, so applying it starts a layout; B replaces it before that layout is done.
    const unplaced = edited({ graph: { ...graph, nodes: graph.nodes.map(({ position: _p, ...n }) => n) } });
    const placed = edited({ graph: { ...graph, nodes: graph.nodes.map((n, i) => ({ ...n, position: { x: 7 + i, y: 11 } })) } });
    type(JSON.stringify(unplaced));
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Canvas/ }));
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Raw JSON/ }));
    type(JSON.stringify(placed));
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Canvas/ }));
    // Let A's layout finish (the layout engine loads and runs asynchronously).
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));

    fireEvent.click(screen.getByRole('button', { name: 'Save flow' }));
    await screen.findByText('Flow saved.');
    const saved = (puts(calls)[0]!.body as { graph: FlowGraph }).graph;
    expect(saved.nodes.map((n) => n.position)).toEqual(placed.graph.nodes.map((n) => n.position));
  });

  it('keeps the edit when the server refuses it, and undoes back to the flow from before', async () => {
    server({ flows: [flow()] });
    const answer = globalThis.fetch;
    const refused = 'Only someone who owns the space \'elsewhere\' can use it in a flow.';
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => (init?.method === 'PUT'
      ? Promise.resolve(Response.json({ detail: refused }, { status: 403 }))
      : answer(url, init))));
    render(<FlowsDialog open onOpenChange={() => {}} />);
    const text = await openRaw();
    const original = text.value;

    const edit = JSON.stringify(edited(), null, 2);
    type(edit);
    fireEvent.click(screen.getByRole('button', { name: 'Save flow' }));
    await screen.findByText(refused);
    expect((screen.getByLabelText('Flow as JSON') as HTMLTextAreaElement).value).toBe(edit);

    // Still unsaved, so leaving still asks.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(confirm).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Undo my changes' }));
    expect((screen.getByLabelText('Flow as JSON') as HTMLTextAreaElement).value).toBe(original);
    expect(JSON.parse(original)).toEqual({ name: 'Statements', enabled: true, graph });
  });
});
