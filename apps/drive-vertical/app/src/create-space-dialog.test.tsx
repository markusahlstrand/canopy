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
