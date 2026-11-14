import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describeFlow, FlowsDialog } from './flows-dialog';
import { FileAutomation } from './file-automation';
import { categoryIdFor } from './categories-editor';
import type { FileDetails, FlowDefinition, StoredFlow } from './api';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const categories = [{ id: 'bank-statement', name: 'Bank statement' }];
const sites = [{ slug: 'qonto', name: 'Qonto', current: true }, { slug: 'a3docs', name: 'A3docs', current: false }];
const definition: FlowDefinition = {
  trigger: { on: 'arrived' }, conditions: [{ field: 'folder', op: 'under', path: 'Statements' }],
  actions: [{ type: 'copy', space: 'a3docs', folderId: 'bancos', alsoIn: [] }], mode: 'ask', versions: 'first',
};
const stored: StoredFlow = { id: 'f1', name: 'Statements', enabled: true, definition, author: 'p', createdAt: '', updatedAt: '', lastRunAt: null, failures: 0, pausedReason: null };

function server(options: { flows?: StoredFlow[]; deliveries?: unknown[]; preview?: unknown } = {}) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const path = new URL(url, 'http://x').pathname;
    if (path.endsWith('/flows') && method === 'GET') return Response.json({ flows: options.flows ?? [] });
    if (path.endsWith('/flows') && method === 'PUT') return Response.json({ ...stored, ...(JSON.parse(String(init!.body)) as object) });
    if (path.endsWith('/flow-deliveries')) return Response.json({ deliveries: options.deliveries ?? [] });
    if (path.endsWith('/flows/preview')) return Response.json(options.preview ?? { matches: [], matched: 0, uncertain: 0, scanned: 0, truncated: false });
    if (path.endsWith('/flows/f1/run')) return Response.json({ started: true }, { status: 202 });
    if (path.endsWith('/flow-deliveries/decide')) return Response.json({ state: 'approved' });
    if (path.endsWith('/sites')) return Response.json(sites);
    if (path.includes('/folders/root/folders')) return Response.json([{ id: 'bancos', name: 'Bancos', parent_id: 'root', path: 'Bancos' }]);
    if (path.includes('/folders/')) return Response.json([]);
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  return calls;
}

describe('the flows dialog', () => {
  it('builds a flow that copies statements into another space, and saves it', async () => {
    const calls = server();
    render(<FlowsDialog open onOpenChange={() => {}} categories={categories} />);
    fireEvent.click(await screen.findByRole('button', { name: /New flow/ }));
    fireEvent.change(screen.getByPlaceholderText('Statements to the gestoría'), { target: { value: 'To the gestoría' } });
    fireEvent.click(screen.getByRole('button', { name: /Add condition/ }));
    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: 'Statements' } });
    fireEvent.change(screen.getByLabelText('Space to copy to'), { target: { value: 'a3docs' } });
    const folder = await screen.findByLabelText('Folder to copy to');
    await waitFor(() => expect(within(folder).getByRole('option', { name: 'Bancos' })).toBeTruthy());
    fireEvent.change(folder, { target: { value: 'bancos' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save flow' }));
    await screen.findByText('Flow saved.');
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toMatchObject({
      name: 'To the gestoría', enabled: true,
      definition: { trigger: { on: 'arrived' }, mode: 'ask', conditions: [{ field: 'folder', op: 'under', path: 'Statements' }], actions: [{ type: 'copy', space: 'a3docs', folderId: 'bancos' }] },
    });
  });

  it('shows what is waiting for approval, and approves it', async () => {
    const calls = server({ flows: [stored], deliveries: [{ flowId: 'f1', fileId: 'file', versionId: 'v1', fileName: 'Statement.pdf', state: 'proposed', detail: {}, attempts: 0, createdAt: '', updatedAt: '' }] });
    render(<FlowsDialog open onOpenChange={() => {}} categories={categories} />);
    const waiting = await screen.findByRole('region', { name: 'Waiting for approval' });
    expect(within(waiting).getByText('Statement.pdf')).toBeTruthy();
    fireEvent.click(within(waiting).getByRole('button', { name: 'Approve' }));
    await screen.findByText('Approved. It runs in a moment.');
    expect(calls.find((c) => c.url.includes('/decide'))!.body).toEqual({ flowId: 'f1', fileId: 'file', versionId: 'v1', decision: 'approve' });
  });

  it('shows which documents already here a flow matches, and runs on them when saved', async () => {
    const calls = server({
      flows: [stored],
      preview: {
        matches: [
          { fileId: 'a', name: 'Statement-01.pdf', folderPath: 'Statements', category: 'bank-statement', needsAnswer: false, handled: false },
          { fileId: 'b', name: 'Statement-02.pdf', folderPath: 'Statements', category: null, needsAnswer: false, handled: true },
        ],
        matched: 2, uncertain: 0, scanned: 40, truncated: false,
      },
    });
    render(<FlowsDialog open onOpenChange={() => {}} categories={categories} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Statements' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show what it matches' }));
    const preview = screen.getByRole('region', { name: 'Documents it matches now' });
    await within(preview).findByText('2 documents match.');
    expect(within(preview).getByText('Statements · Bank statement')).toBeTruthy();
    expect(within(preview).getByText('Already done')).toBeTruthy();
    expect(calls.find((c) => c.url.endsWith('/flows/preview'))!.body).toEqual({ id: 'f1', definition: { conditions: definition.conditions, versions: 'first' } });
    // Changing a condition makes the result stale until checked again.
    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: 'Bank' } });
    expect(within(preview).getByText('The conditions changed since the last check.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: 'Statements' } });
    fireEvent.click(within(preview).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Save flow' }));
    await screen.findByText(/Waiting for you/);
    expect(calls.some((c) => c.url.endsWith('/flows/f1/run') && c.method === 'POST')).toBe(true);
  });

  it('asks again before running on what is here once the conditions change', async () => {
    const calls = server({
      flows: [stored],
      preview: { matches: [{ fileId: 'a', name: 'S.pdf', folderPath: 'Statements', category: null, needsAnswer: false, handled: false }], matched: 1, uncertain: 0, scanned: 1, truncated: false },
    });
    render(<FlowsDialog open onOpenChange={() => {}} categories={categories} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Statements' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show what it matches' }));
    const preview = screen.getByRole('region', { name: 'Documents it matches now' });
    await within(preview).findByText('1 document matches.');
    fireEvent.click(within(preview).getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: 'Everything' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save flow' }));
    await screen.findByText('Flow saved.');
    expect(calls.some((c) => c.url.endsWith('/run'))).toBe(false);
  });

  it('keeps file types as typed', async () => {
    server();
    render(<FlowsDialog open onOpenChange={() => {}} categories={categories} />);
    fireEvent.click(await screen.findByRole('button', { name: /New flow/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add condition/ }));
    fireEvent.change(screen.getByLabelText('Condition 1'), { target: { value: 'extension' } });
    const types = screen.getByLabelText('File types') as HTMLInputElement;
    fireEvent.change(types, { target: { value: 'pdf, ' } });
    expect(types.value).toBe('pdf, ');
    fireEvent.change(types, { target: { value: 'pdf, .XML' } });
    fireEvent.blur(types);
    expect(types.value).toBe('pdf, xml');
  });

  it('says what a flow does in one line', () => {
    expect(describeFlow(definition, categories, sites)).toBe('When a document arrives (under Statements): copy to A3docs, after you approve.');
    expect(describeFlow({ ...definition, trigger: { on: 'classified' }, conditions: [{ field: 'category', values: ['bank-statement'], minConfidence: 0.7 }], mode: 'auto' }, categories, sites))
      .toBe('When a document is categorised (Bank statement): copy to A3docs.');
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
