import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FlowsDialog } from './flows-dialog';
import { FlowApprovals } from './flow-approvals';
import type { DecisionResult, DeliveryView, FlowView } from './api';
import { bulkAction, columnHeader, fileRow, fileRows, rowAction, rowText, toggleAll } from './test-table';

const navigation = vi.hoisted(() => ({ openSpaceFile: vi.fn((_slug: string, _fileId: string) => true) }));
vi.mock('./space-navigation', async (original) => ({ ...(await original<typeof import('./space-navigation')>()), openSpaceFile: navigation.openSpaceFile }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); navigation.openSpaceFile.mockClear(); });

const flow: FlowView = {
  id: 'f1', name: 'Invoices to a3doc', enabled: true, author: 'p', createdAt: '', updatedAt: '', failures: 0, pausedReason: null,
  graph: { nodes: [{ id: 't', type: 'trigger', on: 'arrived', spaces: ['qonto'] }, { id: 'w', type: 'approval' }], edges: [{ from: 't', to: 'w', branch: 'next' }], versions: 'first' },
  spaces: [{ slug: 'qonto', name: 'Qonto', watch: true, write: false }, { slug: 'a3', name: 'a3doc', watch: false, write: true }],
};
const proposal = (fileId: string, over: Partial<DeliveryView> = {}): DeliveryView => ({
  space: 'qonto', flowId: 'f1', flowName: 'Invoices to a3doc', fileId, versionId: 'v1', fileName: `${fileId}.pdf`,
  state: 'proposed', detail: {}, attempts: 0, createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z',
  folderPath: 'Invoices/2026/09', filedIn: ['a3doc › Facturas/2026/09'], ...over,
});

type Item = { space: string; flowId: string; fileId: string; versionId: string; decision: string };

/**
 * The flow routes, keeping each delivery's state: a decision moves it only from 'proposed', as the
 * route's guard does. `refuse` names documents the space will not let the caller decide.
 */
function server(proposals: DeliveryView[], refuse: Record<string, string> = {}, hold?: (request: number) => Promise<void>) {
  const states = new Map(proposals.map((p) => [p.fileId, p.state as string]));
  const decided: { items?: Item[]; single?: Item }[] = [];
  const decideOne = (item: Item): DecisionResult => {
    const key = { space: item.space, flowId: item.flowId, fileId: item.fileId, versionId: item.versionId };
    const refused = refuse[item.fileId];
    if (refused) return { ...key, ok: false, status: 403, error: refused };
    if (states.get(item.fileId) !== 'proposed') return { ...key, ok: false, status: 409, error: 'Someone already decided this one.' };
    const state = item.decision === 'approve' ? 'approved' as const : 'dismissed' as const;
    states.set(item.fileId, state);
    return { ...key, ok: true, state };
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const at = new URL(url, 'http://x');
    const method = init?.method ?? 'GET';
    if (at.pathname.endsWith('/flows') && method === 'GET') return Response.json({ flows: [flow], spaces: [{ slug: 'qonto', name: 'Qonto' }, { slug: 'a3', name: 'a3doc' }] });
    if (at.pathname.endsWith('/flow-deliveries')) {
      const now = proposals.map((p) => ({ ...p, state: states.get(p.fileId) as DeliveryView['state'] }));
      return Response.json({ deliveries: at.searchParams.get('state') === 'proposed' ? now.filter((p) => p.state === 'proposed') : now });
    }
    if (at.pathname.endsWith('/flow-deliveries/decide')) {
      const body = JSON.parse(String(init!.body)) as { items?: Item[] } & Item;
      if (body.items) {
        decided.push({ items: body.items });
        await hold?.(decided.length);
        return Response.json({ results: body.items.map(decideOne) });
      }
      decided.push({ single: body });
      const result = decideOne(body);
      return result.ok ? Response.json({ ...body, state: result.state }) : Response.json({ detail: result.error }, { status: result.status });
    }
    return Response.json({});
  }));
  return { states, decided };
}

/** The table shows `n` rows, each with its cells drawn. */
const shows = (n: number) => waitFor(() => {
  expect(fileRows()).toHaveLength(n);
  expect(fileRows().every((row) => rowText(row).includes('.pdf'))).toBe(true);
});
const rowNames = () => fileRows().map((row) => rowText(row).split('.pdf')[0]!.trim());

describe('documents waiting for approval, in the file table', () => {
  it('says where each comes from, the flow, where it would go and when it arrived, and sorts', async () => {
    server([proposal('b-invoice'), proposal('a-invoice', { space: 'a3', folderPath: '', filedIn: undefined, createdAt: '2026-09-02T10:00:00.000Z' })]);
    render(<FlowsDialog open onOpenChange={() => {}} />);
    await shows(2);
    const row = rowText(fileRow('b-invoice.pdf'));
    expect(row).toContain('Qonto › Invoices/2026/09');
    expect(row).toContain('Invoices to a3doc');
    expect(row).toContain('a3doc › Facturas/2026/09');
    expect(row).toMatch(/2026/);
    // A document at the top of its space, whose destination can't be worked out.
    expect(rowText(fileRow('a-invoice.pdf'))).toContain('a3doc › Top level');
    expect(screen.getByText('Waiting for you · 2')).toBeTruthy();

    expect(rowNames()).toEqual(['b-invoice', 'a-invoice']);
    fireEvent.click(columnHeader('Name'));
    await waitFor(() => expect(rowNames()).toEqual(['a-invoice', 'b-invoice']));
    fireEvent.click(columnHeader('Name'));
    await waitFor(() => expect(rowNames()).toEqual(['b-invoice', 'a-invoice']));
  });

  it('approves everything selected in batches, showing how far it got', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const many = ['a', 'b', 'c', 'd', 'e'].map((f) => proposal(f));
    // The second request waits, so the progress shows what the first did.
    const { decided, states } = server(many, {}, (request) => (request === 2 ? held : Promise.resolve()));
    const onDecided = vi.fn();
    render(<FlowApprovals chunk={2} spaceName={(slug) => (slug === 'qonto' ? 'Qonto' : slug)} include={null} refresh="" onDecided={onDecided} onOpen={() => {}} />);
    await shows(5);
    toggleAll();
    fireEvent.click(await waitFor(() => bulkAction('Approve')));
    await screen.findByText('Approving 2 of 5…');
    expect(screen.getByRole('progressbar', { name: 'Approving documents' })).toHaveProperty('value', 2);
    release();
    await screen.findByText('Approved 5 of 5. They run in a moment.');
    // One request per batch, not one per document; each item says approve.
    expect(decided.map((d) => d.items!.map((i) => i.fileId))).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(decided.flatMap((d) => d.items!.map((i) => i.decision))).toEqual(Array(5).fill('approve'));
    expect([...states.values()]).toEqual(Array(5).fill('approved'));
    // Decided, they leave the table, and what flows did lately is asked again.
    await shows(0);
    expect(onDecided).toHaveBeenCalled();
  });

  it('rejects a selection, keeping what worked and saying which failed and why', async () => {
    const { decided, states } = server([proposal('ok'), proposal('locked'), proposal('raced')], { locked: 'You cannot change deliveries here.' });
    render(<FlowsDialog open onOpenChange={() => {}} />);
    await shows(3);
    // Someone else decides one in another tab after it was listed here.
    states.set('raced', 'approved');
    toggleAll();
    fireEvent.click(await waitFor(() => bulkAction('Reject')));
    await screen.findByText('Rejected 1 of 3.');
    expect(decided).toHaveLength(1);
    expect(decided[0]!.items!.map((i) => i.decision)).toEqual(['dismiss', 'dismiss', 'dismiss']);
    const failed = screen.getByRole('list', { name: 'Not decided' });
    expect(within(failed).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'locked.pdf — You cannot change deliveries here.',
      'raced.pdf — Someone already decided this one.',
    ]);
    expect(screen.getByRole('alert').textContent).toContain('2 documents couldn’t be rejected');
    expect(states.get('ok')).toBe('dismissed');
    // What was refused, and still waits, stays to be decided.
    await waitFor(() => expect(rowNames()).toEqual(['locked']));
  });

  it('decides one document from its row, and only once however often it is clicked', async () => {
    const { decided } = server([proposal('one'), proposal('two')]);
    render(<FlowsDialog open onOpenChange={() => {}} />);
    await shows(2);
    const approve = rowAction(fileRow('one.pdf'), 'Approve');
    fireEvent.click(approve);
    fireEvent.click(approve);
    await screen.findByText('Approved. It runs in a moment.');
    await waitFor(() => expect(rowNames()).toEqual(['two']));
    expect(decided).toEqual([{ single: { space: 'qonto', flowId: 'f1', fileId: 'one', versionId: 'v1', decision: 'approve' } }]);
  });

  it('opens a document of this space in its preview, and one elsewhere in its own space', async () => {
    server([proposal('here', { space: 'a3' }), proposal('there')]);
    const onOpenFile = vi.fn(() => true);
    const onOpenChange = vi.fn();
    render(<FlowsDialog open onOpenChange={onOpenChange} here="a3" onOpenFile={onOpenFile} />);
    await shows(2);
    fireEvent.doubleClick(screen.getByText('here.pdf'));
    await waitFor(() => expect(onOpenFile).toHaveBeenCalledWith('here'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    fireEvent.doubleClick(screen.getByText('there.pdf'));
    await waitFor(() => expect(navigation.openSpaceFile).toHaveBeenCalledWith('qonto', 'there'));
    expect(onOpenFile).toHaveBeenCalledTimes(1);
  });

  it('keeps the table, and what it says of a running batch, on screen until the batch is through', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    server([proposal('one'), proposal('two')], { two: 'You cannot change deliveries here.' }, () => held);
    const onOpenChange = vi.fn();
    render(<FlowsDialog open onOpenChange={onOpenChange} />);
    await shows(2);
    toggleAll();
    fireEvent.click(await waitFor(() => bulkAction('Approve')));
    await screen.findByText('Approving 0 of 2…');
    // Nothing that would take the table away while it runs: no editor, no closing.
    const newFlow = screen.getByRole('button', { name: /New flow/ }) as HTMLButtonElement;
    expect(newFlow.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Edit Invoices to a3doc' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    release();
    await screen.findByText('Approved 1 of 2. They run in a moment.');
    expect(screen.getByRole('list', { name: 'Not decided' }).textContent).toContain('two.pdf — You cannot change deliveries here.');
    await waitFor(() => expect(newFlow.disabled).toBe(false));
  });

  it('drops the proposals of a flow deleted here, even ones older than what flows did lately', async () => {
    let deleted = false;
    let proposedReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const at = new URL(url, 'http://x');
      const method = init?.method ?? 'GET';
      if (at.pathname.endsWith('/flows') && method === 'GET') return Response.json({ flows: deleted ? [] : [flow], spaces: [{ slug: 'qonto', name: 'Qonto' }] });
      if (at.pathname.endsWith('/flows/f1') && method === 'DELETE') { deleted = true; return Response.json({ ok: true }); }
      if (at.pathname.endsWith('/flow-deliveries')) {
        // The proposal is older than the latest deliveries the dialog polls, which say nothing of it.
        if (at.searchParams.get('state') !== 'proposed') return Response.json({ deliveries: [] });
        proposedReads++;
        return Response.json({ deliveries: deleted ? [] : [proposal('old')] });
      }
      return Response.json({});
    }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<FlowsDialog open onOpenChange={() => {}} />);
    await shows(1);
    const before = proposedReads;
    fireEvent.click(screen.getByRole('button', { name: 'Delete Invoices to a3doc' }));
    await screen.findByText('Flow deleted.');
    await shows(0);
    expect(proposedReads).toBe(before + 1);
  });

  it('on a phone, a tap opens the document in a bottom sheet to decide', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 767px)', media: query, addEventListener: () => {}, removeEventListener: () => {},
    }));
    const { decided } = server([proposal('phone')]);
    render(<FlowsDialog open onOpenChange={() => {}} />);
    await shows(1);
    fireEvent.click(screen.getByText('phone.pdf'));
    const sheet = await screen.findByRole('dialog', { name: /phone\.pdf/ });
    expect(sheet.textContent).toContain('Qonto › Invoices/2026/09');
    expect(sheet.textContent).toContain('a3doc › Facturas/2026/09');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Approve' }));
    await screen.findByText('Approved. It runs in a moment.');
    expect(decided).toEqual([{ single: expect.objectContaining({ fileId: 'phone', decision: 'approve' }) }]);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /phone\.pdf/ })).toBeNull());
  });
});
