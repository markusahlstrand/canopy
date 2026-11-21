import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EntityExtractionContext, FileGraphPanel, SuggestionsDialog } from './graph-review';
import type { GraphClaim } from './api';

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
