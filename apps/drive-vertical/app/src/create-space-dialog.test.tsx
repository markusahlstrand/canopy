import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CreateSpaceDialog } from './create-space-dialog';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('waits for durable creation before opening the space and posts name, generated slug and presentation settings', async () => {
  const created = vi.fn(); let done = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/sites') { done = true; return new Response(JSON.stringify({ id: 'r', name: 'Family', slug: 'family-created' })); }
    return new Response(JSON.stringify({ requests: done ? [{ id: 'r', name: 'Family', slug: 'family-created', status: 'done', error: null }] : [] }));
  });
  vi.stubGlobal('fetch', fetcher); render(<CreateSpaceDialog open onOpenChange={() => {}} onCreated={created} />);
  fireEvent.change(screen.getByLabelText('Space name'), { target: { value: 'Family' } });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Create space' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Create space' }));
  await waitFor(() => expect(created).toHaveBeenCalledExactlyOnceWith('family-created'));
  const body = JSON.parse(fetcher.mock.calls.find(call => call[1]?.method === 'POST')![1]!.body as string); expect(Object.keys(body)).toEqual(['name', 'slug', 'settings']); expect(body.name).toBe('Family');
});
it('keeps the creation form available when the request fails', async () => {
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => init?.method === 'POST' ? new Response('Forbidden', { status: 403 }) : new Response(JSON.stringify({requests:[]})));
  render(<CreateSpaceDialog open onOpenChange={() => {}} onCreated={() => {}} />);
  fireEvent.change(screen.getByLabelText('Space name'), { target: { value: 'Family' } });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Create space' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Create space' }));
  await screen.findByRole('alert'); expect((screen.getByLabelText('Space name') as HTMLInputElement).value).toBe('Family');
});
it('resumes tracking a pending creation request when reopened', async () => {
  const created = vi.fn(); let complete = false;
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({requests:[{id:'old',name:'Family',slug:'family-old',status:complete?'done':'pending',error:null}]})));
  vi.stubGlobal('fetch', fetcher);
  render(<CreateSpaceDialog open onOpenChange={() => {}} onCreated={created} />);
  expect(await screen.findByText(/Creating your space/)).toBeTruthy();
  expect((screen.getByRole('button',{name:'Create space'}) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText('Space name') as HTMLInputElement).value).toBe('Family');
  complete = true;
  await waitFor(() => expect(created).toHaveBeenCalledWith('family-old'), {timeout:4000});
  expect(fetcher.mock.calls.every(call => call[1]?.method !== 'POST')).toBe(true);
});
it('explains a missing status entry and keeps polling the original request', async () => {
  const created = vi.fn(); let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({requests: [{id:'old',name:'Family',slug:'family-old',status:++reads >= 3 ? 'done' : 'pending',error:null}].filter(() => reads !== 2)}))));
  render(<CreateSpaceDialog open onOpenChange={() => {}} onCreated={created} />);
  expect(await screen.findByText(/latest status did not include this request/)).toBeTruthy();
  expect((screen.getByRole('button', {name:'Create space'}) as HTMLButtonElement).disabled).toBe(true);
  await waitFor(() => expect(created).toHaveBeenCalledWith('family-old'), { timeout: 4000 });
  expect(screen.queryByText(/latest status did not include this request/)).toBeNull();
});
it('lets an owner start another space after a request has been pending for five minutes', async () => {
  const old = new Date(Date.now() - 6 * 60_000).toISOString();
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'POST'
    ? {id:'new',name:'Team',slug:'team-new'}
    : {requests:[{id:'old',name:'Family',slug:'family-old',status:'pending',error:null,requestedAt:old}]}))));
  render(<CreateSpaceDialog open onOpenChange={() => {}} onCreated={() => {}} />);
  fireEvent.click(await screen.findByRole('button',{name:'Start a different space'}));
  expect((screen.getByLabelText('Space name') as HTMLInputElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('Space name'),{target:{value:'Team'}});
  expect((screen.getByRole('button',{name:'Create space'}) as HTMLButtonElement).disabled).toBe(false);
});
it('offers recovery when a pending request becomes stale while the dialog stays open', async () => {
  const almostOld = new Date(Date.now() - 5 * 60_000 + 400).toISOString();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({requests:[{id:'old',name:'Family',slug:'family-old',status:'pending',error:null,requestedAt:almostOld}]}))));
  render(<CreateSpaceDialog open onOpenChange={() => {}} onCreated={() => {}} />);
  await screen.findByText(/Creating your space/);
  expect(screen.queryByRole('button', { name: 'Start a different space' })).toBeNull();
  expect(await screen.findByRole('button', { name: 'Start a different space' }, { timeout: 1200 })).toBeTruthy();
});
it('keeps Create disabled until a failed status check is retried successfully', async () => {
  let fail = true;
  vi.stubGlobal('fetch', vi.fn(async () => fail ? new Response('Unavailable',{status:503}) : new Response(JSON.stringify({requests:[]}))));
  render(<CreateSpaceDialog open onOpenChange={() => {}} onCreated={() => {}} />);
  fireEvent.change(screen.getByLabelText('Space name'),{target:{value:'Family'}});
  await screen.findByRole('button',{name:'Retry status check'});
  expect((screen.getByRole('button',{name:'Create space'}) as HTMLButtonElement).disabled).toBe(true);
  fail = false;
  fireEvent.click(screen.getByRole('button',{name:'Retry status check'}));
  await waitFor(()=>expect((screen.getByRole('button',{name:'Create space'}) as HTMLButtonElement).disabled).toBe(false));
});
const a3docWorld = (connect: (init: RequestInit) => Response) => {
  let done = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/sites') { done = true; return new Response(JSON.stringify({ id: 'r', name: 'Books', slug: 'books-1' })); }
    if (url === '/api/source') return connect(init!);
    return new Response(JSON.stringify({ requests: done ? [{ id: 'r', name: 'Books', slug: 'books-1', status: 'done', error: null }] : [] }));
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
};
const fillA3doc = async () => {
  fireEvent.change(screen.getByLabelText('Space name'), { target: { value: 'Books' } });
  fireEvent.click(screen.getByRole('radio', { name: /a3doc folder/ }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Create space' }) as HTMLButtonElement).disabled).toBe(true));
  fireEvent.change(screen.getByLabelText('Company code'), { target: { value: 'ACME' } });
  fireEvent.change(screen.getByLabelText('User'), { target: { value: 'ana' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
  fireEvent.change(screen.getByLabelText('a3doc folder'), { target: { value: 'Facturas' } });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Create space' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Create space' }));
};
it('connects a new space to a3doc once it exists, then opens it', async () => {
  const created = vi.fn();
  const fetcher = a3docWorld(() => new Response(JSON.stringify({ provider: 'canopy.a3doc' })));
  render(<CreateSpaceDialog open onOpenChange={() => {}} onCreated={created} />);
  await fillA3doc();
  await waitFor(() => expect(created).toHaveBeenCalledExactlyOnceWith('books-1'));
  const put = fetcher.mock.calls.find(call => call[0] === '/api/source')!;
  expect(put[1]!.method).toBe('PUT');
  expect((put[1]!.headers as Record<string, string>)['x-site']).toBe('books-1');
  expect(JSON.parse(put[1]!.body as string)).toEqual({ companyCode: 'ACME', user: 'ana', password: 'pw', folder: 'Facturas' });
  // The login never reaches the space request itself.
  expect(fetcher.mock.calls.find(call => call[0] === '/api/sites')![1]!.body).not.toContain('pw');
});
it('keeps the created space when a3doc refuses the login, and offers to open it', async () => {
  const created = vi.fn();
  a3docWorld(() => new Response(JSON.stringify({ detail: 'a3doc refused the login' }), { status: 400 }));
  render(<CreateSpaceDialog open onOpenChange={() => {}} onCreated={created} />);
  await fillA3doc();
  expect(await screen.findByText(/a3doc did not connect: a3doc refused the login/)).toBeTruthy();
  expect(created).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open the space' }));
  expect(created).toHaveBeenCalledExactlyOnceWith('books-1');
});
it('handles a finished request once when overlapping polls both report it done', async () => {
  const created = vi.fn(); let posted = false, held: (() => void)[] = [], finishConnect = () => {};
  const realInterval = globalThis.setInterval;
  // A slow status read outlives the poll interval; shorten it so the two overlap in test time.
  vi.stubGlobal('setInterval', (run: () => void, ms: number) => realInterval(run, ms === 3000 ? 10 : ms));
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === '/api/sites') { posted = true; return new Response(JSON.stringify({ id: 'r', name: 'Books', slug: 'books-1' })); }
    if (url === '/api/source') { await new Promise<void>(resolve => { finishConnect = resolve; }); return new Response(JSON.stringify({ provider: 'canopy.a3doc' })); }
    if (posted) {
      await new Promise<void>(resolve => { held.push(resolve); if (held.length === 2) { held.forEach(release => release()); held = []; } });
      return new Response(JSON.stringify({ requests: [{ id: 'r', name: 'Books', slug: 'books-1', status: 'done', error: null }] }));
    }
    return new Response(JSON.stringify({ requests: [] }));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<CreateSpaceDialog open onOpenChange={() => {}} onCreated={created} />);
  await fillA3doc();
  await waitFor(() => expect(fetcher.mock.calls.some(call => call[0] === '/api/source')).toBe(true));
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(created).not.toHaveBeenCalled();
  finishConnect();
  await waitFor(() => expect(created).toHaveBeenCalledExactlyOnceWith('books-1'));
  expect(fetcher.mock.calls.filter(call => call[0] === '/api/source')).toHaveLength(1);
});
