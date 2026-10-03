import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CreateSpaceDialog } from './create-space-dialog';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('waits for durable creation before opening the space and posts only name and generated slug', async () => {
  const created = vi.fn(); let done = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/sites') { done = true; return new Response(JSON.stringify({ id: 'r', name: 'Family', slug: 'family-created' })); }
    return new Response(JSON.stringify({ requests: [{ id: 'r', name: 'Family', slug: 'family-created', status: done ? 'done' : 'pending', error: null }] }));
  });
  vi.stubGlobal('fetch', fetcher); render(<CreateSpaceDialog open onOpenChange={() => {}} onCreated={created} />);
  fireEvent.change(screen.getByLabelText('Space name'), { target: { value: 'Family' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create space' }));
  await waitFor(() => expect(created).toHaveBeenCalledExactlyOnceWith('family-created'));
  const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string); expect(Object.keys(body)).toEqual(['name', 'slug']); expect(body.name).toBe('Family');
});
it('keeps the creation form available when the request fails', async () => {
  vi.stubGlobal('fetch', async () => new Response('Forbidden', { status: 403 }));
  render(<CreateSpaceDialog open onOpenChange={() => {}} onCreated={() => {}} />);
  fireEvent.change(screen.getByLabelText('Space name'), { target: { value: 'Family' } }); fireEvent.click(screen.getByRole('button', { name: 'Create space' }));
  await screen.findByRole('alert'); expect((screen.getByLabelText('Space name') as HTMLInputElement).value).toBe('Family');
});
