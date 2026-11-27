import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EntityExtractionContext, FileGraphPanel, lookAlikes, SuggestionsDialog } from './graph-review';
import type { GraphClaim, GraphEntity, GraphEntitySummary } from './api';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const acme = { id: 'e1', type: 'Organization' as const, name: 'Acme S.L.', status: 'suggested' as const };
const claim = (over: Partial<GraphClaim> & { id: string }): GraphClaim => ({
  subject: { kind: 'document', fileId: 'f1', name: 'factura.pdf' },
  predicate: 'provider',
  object: { kind: 'entity', entity: acme },
  fileId: 'f1', fileName: 'factura.pdf', versionId: 'v1',
  quote: 'Acme S.L. — Factura 42', confidence: 0.92, extractedBy: 'model', validTime: '2026-10-01', ingestTime: '2026-11-01T00:00:00Z',
  status: 'suggested', decidedBy: null, decidedAt: null, replaces: [],
  ...over,
});

function mockApi(claims: GraphClaim[], canWrite = true) {
  let current = claims;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/graph/decisions')) {
      const body = JSON.parse(init!.body as string) as { claimIds: string[]; decision: 'accept' | 'reject' };
      current = current.map((c) => (body.claimIds.includes(c.id) ? { ...c, status: body.decision === 'accept' ? 'accepted' : 'rejected' } : c));
      return new Response(JSON.stringify({ changed: body.claimIds.length, claims: current }));
    }
    if (url.includes('/graph/suggestions')) return new Response(JSON.stringify({ claims: current.filter((c) => c.status === 'suggested') }));
    if (url.includes('/graph/entities/')) {
      return new Response(JSON.stringify({ entity: { ...acme, status: 'accepted' }, claims: current, connections: [{ entity: { id: 'e2', type: 'Organization', name: 'Canopy AB', status: 'accepted' }, depth: 2, via: ['provider', 'customer'] }] }));
    }
    if (url.endsWith('/extract-entities')) return new Response(JSON.stringify({ queued: 1, skipped: 0, more: false }), { status: 202 });
    return new Response(JSON.stringify({ claims: current, canWrite }));
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('a file’s people and companies', () => {
  it('shows a suggestion with its quote and confidence, and accepts it', async () => {
    const fetch = mockApi([claim({ id: 'c1' }), claim({ id: 'c2', predicate: 'totalPaymentDue', object: { kind: 'value', valueKind: 'money', value: '1210.00 EUR', display: '1210.00 EUR' }, quote: null, confidence: 0.8 })]);
    render(<FileGraphPanel fileId="f1" />);
    expect(await screen.findByText('“Acme S.L. — Factura 42”')).toBeTruthy();
    expect(screen.getAllByText('This document')).toHaveLength(2);
    expect(screen.getByText('was issued by')).toBeTruthy();
    expect(screen.getByText('92% sure')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Accept' })[0]!);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/files/f1/graph/decisions', expect.objectContaining({ method: 'POST', body: JSON.stringify({ claimIds: ['c1'], decision: 'accept' }) })));
    expect(await screen.findByText('Known')).toBeTruthy();
    expect(screen.getByText('Suggested (1)')).toBeTruthy();
  });

  it('offers reading the file where the space has it on, and hides itself where it is off and nothing was read', async () => {
    const fetch = mockApi([]);
    const { unmount } = render(<EntityExtractionContext.Provider value><FileGraphPanel fileId="f1" /></EntityExtractionContext.Provider>);
    fireEvent.click(await screen.findByRole('button', { name: /Find people and companies/ }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/extract-entities', expect.objectContaining({ body: JSON.stringify({ fileId: 'f1' }) })));
    expect(await screen.findByRole('status')).toBeTruthy();
    unmount();
    render(<FileGraphPanel fileId="f1" />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(screen.queryByLabelText('People and companies')).toBeNull();
  });

  it('readers see suggestions without the buttons to decide them', async () => {
    mockApi([claim({ id: 'c1' })], false);
    render(<FileGraphPanel fileId="f1" />);
    await screen.findByText('was issued by');
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });

  it('opens an entity’s card with what it connects to', async () => {
    mockApi([claim({ id: 'c1', status: 'accepted' })]);
    render(<FileGraphPanel fileId="f1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Acme S.L.' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Canopy AB')).toBeTruthy();
    expect(within(dialog).getByText('was issued by → is addressed to')).toBeTruthy();
  });
});

describe('the space’s suggestions', () => {
  it('groups by file and accepts a file’s suggestions together', async () => {
    const fetch = mockApi([
      claim({ id: 'c1' }),
      claim({ id: 'c2', subject: { kind: 'entity', entity: acme }, predicate: 'vatID', object: { kind: 'value', valueKind: 'vatID', value: 'ESB58818501', display: 'ESB58818501' } }),
      claim({ id: 'c3', fileId: 'f2', fileName: 'memo.pdf', subject: { kind: 'document', fileId: 'f2', name: 'memo.pdf' }, predicate: 'mentions' }),
    ]);
    const onOpenFile = vi.fn();
    render(<SuggestionsDialog open onOpenChange={() => {}} onOpenFile={onOpenFile} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept all 2' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/files/f1/graph/decisions', expect.objectContaining({ body: JSON.stringify({ claimIds: ['c1', 'c2'], decision: 'accept' }) })));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'factura.pdf' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'memo.pdf' }));
    expect(onOpenFile).toHaveBeenCalledWith('f2');
  });
});

const summary = (id: string, name: string, type: GraphEntity['type'] = 'Organization', documents = 1, status: GraphEntity['status'] = 'suggested'): GraphEntitySummary =>
  ({ entity: { id, type, name, status }, documents });

describe('look-alike entities', () => {
  it('groups names whose words agree once case, accents and legal form are set aside', () => {
    const groups = lookAlikes([
      summary('o1', 'Acme, S.L.'), summary('o2', 'ACME Servicios'), summary('o3', 'Canopy AB'),
      summary('p1', 'Ana López', 'Person'), summary('p2', 'Ana Lopez Garcia', 'Person'), summary('p3', 'Ana Martín', 'Person'),
      summary('x1', 'Acme', 'Place'),
    ]);
    expect(groups.map((g) => g.map((s) => s.entity.id))).toEqual([['o1', 'o2'], ['p1', 'p2']]);
  });

  it('does not go on a first name alone', () => {
    expect(lookAlikes([summary('p1', 'Ana', 'Person'), summary('p2', 'Ana López', 'Person')])).toEqual([]);
  });
});

describe('merging people and companies in Suggestions', () => {
  function mockEntities(entities: GraphEntitySummary[], options: { canMerge?: boolean; mergeError?: string } = {}) {
    let list = entities;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/merge')) {
        if (options.mergeError) return new Response(JSON.stringify({ detail: options.mergeError }), { status: 409, statusText: 'Conflict' });
        const keep = decodeURIComponent(url.split('/graph/entities/')[1]!.replace('/merge', ''));
        const body = JSON.parse(init!.body as string) as { mergeIds: string[] };
        const kept = list.find((s) => s.entity.id === keep)!;
        list = list.filter((s) => !body.mergeIds.includes(s.entity.id));
        return new Response(JSON.stringify({ entity: kept.entity, merged: body.mergeIds.length, moved: 3, superseded: 0 }));
      }
      if (url.includes('/graph/entities?')) return new Response(JSON.stringify({ entities: list, canMerge: options.canMerge ?? true }));
      if (url.includes('/graph/suggestions')) return new Response(JSON.stringify({ claims: [] }));
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }
  const openPeople = async () => {
    render(<SuggestionsDialog open onOpenChange={() => {}} />);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'People and companies' }));
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    return screen.queryByRole('region', { name: 'Possibly the same' });
  };

  it('offers look-alikes together, keeps the confirmed name by default, and merges', async () => {
    const fetch = mockEntities([
      summary('e1', 'Acme S.L.', 'Organization', 2, 'accepted'), summary('e3', 'ACME Servicios', 'Organization', 3), summary('e2', 'Canopy AB'),
    ]);
    const alike = await openPeople();
    expect(within(alike!).getByText('Acme S.L.')).toBeTruthy();
    expect(within(alike!).getByText('ACME Servicios')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Everyone else' })).getByText('Canopy AB')).toBeTruthy();

    fireEvent.click(within(alike!).getByRole('button', { name: 'Merge these 2…' }));
    const confirm = await screen.findByRole('region', { name: 'Merge' });
    // Confirmed beats more documents.
    expect((within(confirm).getByRole('radio', { name: /Acme S\.L\./ }) as HTMLInputElement).checked).toBe(true);
    const before = fetch.mock.calls.filter(([u]) => String(u).includes('/graph/suggestions')).length;
    fireEvent.click(within(confirm).getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/graph/entities/e1/merge', expect.objectContaining({ method: 'POST', body: JSON.stringify({ mergeIds: ['e3'] }) })));
    expect(await screen.findByText('Merged 2 into “Acme S.L.”.')).toBeTruthy();
    expect(screen.queryByText('ACME Servicios')).toBeNull();
    // The statements name the kept entity now: they are read again.
    await waitFor(() => expect(fetch.mock.calls.filter(([u]) => String(u).includes('/graph/suggestions')).length).toBe(before + 1));
  });

  it('merges a hand-picked selection into the name chosen, and will not mix kinds', async () => {
    const fetch = mockEntities([summary('o1', 'Northwind'), summary('o2', 'NW Trading'), summary('p1', 'Bo Ek', 'Person')]);
    await openPeople();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Northwind' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Bo Ek' }));
    expect(screen.getByText(/Only the same kind can be merged/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Merge 2…' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Bo Ek' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select NW Trading' }));
    fireEvent.click(screen.getByRole('button', { name: 'Merge 2…' }));
    fireEvent.click(await screen.findByRole('radio', { name: /NW Trading/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/graph/entities/o2/merge', expect.objectContaining({ body: JSON.stringify({ mergeIds: ['o1'] }) })));
  });

  it('says why the space refused a merge, and stays on the choice', async () => {
    mockEntities([summary('e1', 'Acme'), summary('e2', 'Acme Iberia')], { mergeError: 'Not the same: they have different VAT number (ESB1, ESA1), and that never changes.' });
    const alike = await openPeople();
    fireEvent.click(within(alike!).getByRole('button', { name: 'Merge these 2…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    expect((await screen.findByRole('alert')).textContent).toContain('different VAT number');
    expect(screen.getByRole('region', { name: 'Merge' })).toBeTruthy();
  });

  it('readers see the list without anything to merge with, and can search it', async () => {
    mockEntities([summary('e1', 'Acme'), summary('e2', 'Acme Iberia'), summary('e3', 'Canopy AB')], { canMerge: false });
    await openPeople();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Merge/ })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a person or company' }), { target: { value: 'canópy' } });
    expect(screen.getByText('Canopy AB')).toBeTruthy();
    expect(screen.queryByText('Acme')).toBeNull();
  });
});
