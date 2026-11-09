import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MailSettings, parseAllowlist } from './mail-settings';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const held = (allowlist: string[]) => ({
  address: 'mail+drive-k3x9@in.substrat.run', allowlist, createdAt: '2026-11-08T10:00:00.000Z',
  stats: { received: 2, delivered: 2, rejected: 1, deadLettered: 0, pending: 0, lastReceivedAt: null, lastRejectReason: null },
});

function platform(options: { status?: number; connected?: boolean } = {}) {
  let address: ReturnType<typeof held> | null = null;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/me')) return Response.json({ principal: 'p', user: { email: 'me@example.com' } });
    if (!url.endsWith('/mail')) return new Response(null, { status: 404 });
    if (options.status) return Response.json({ detail: 'no' }, { status: options.status });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { action: string; allowlist?: string[] };
      address = body.action === 'revoke' ? null : held(body.allowlist ?? []);
    }
    return Response.json({ address, connected: !!options.connected, messages: 2, lastReceivedAt: null });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

it('gets an address that starts with your own email as the only sender, and turns it off', async () => {
  const fetcher = platform();
  render(<MailSettings disabled={false}/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Get an address' }));
  const input = await screen.findByLabelText('Who may send');
  await waitFor(() => expect((input as HTMLInputElement).value).toBe('me@example.com'));
  fireEvent.change(input, { target: { value: 'me@example.com, @Supplier.example' } });
  fireEvent.click(screen.getByRole('button', { name: 'Get an address' }));
  await screen.findByText('mail+drive-k3x9@in.substrat.run');
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(JSON.parse(post[1]!.body as string)).toEqual({ action: 'request', allowlist: ['me@example.com', '@supplier.example'] });
  expect(screen.getByText('Only from me@example.com, @supplier.example.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
  await screen.findByText('No address');
});

it('renders nothing for someone who may not manage the space', async () => {
  platform({ status: 403 });
  const { container } = render(<MailSettings disabled={false}/>);
  await waitFor(() => expect(container.innerHTML).toBe(''));
});

it('explains why a connected space has no address', async () => {
  platform({ connected: true });
  render(<MailSettings disabled={false}/>);
  await screen.findByText(/mirrors a connected source/);
  expect(screen.queryByRole('button', { name: 'Get an address' })).toBeNull();
});

it('offers a retry when the platform fails, and renders the address once it answers', async () => {
  let fail = true;
  vi.stubGlobal('fetch', vi.fn(async () => fail ? Response.json({ detail: 'mail service down' }, { status: 502 }) : Response.json({ address: held([]), connected: false, messages: 0, lastReceivedAt: null })));
  render(<MailSettings disabled={false}/>);
  await screen.findByRole('alert');
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByText('mail+drive-k3x9@in.substrat.run');
});

it('says so when the address could not be copied', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ address: held([]), connected: false, messages: 0, lastReceivedAt: null })));
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) } });
  render(<MailSettings disabled={false}/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Copy address' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Could not copy');
  expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
});

it('reports a sender edit as a draft until it is cancelled', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ address: held(['me@example.com']), connected: false, messages: 0, lastReceivedAt: null })));
  const draft = vi.fn();
  render(<MailSettings disabled={false} onDraftChange={draft}/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Change senders' }));
  expect(draft).not.toHaveBeenCalledWith(true);
  fireEvent.change(screen.getByLabelText('Who may send'), { target: { value: 'you@example.com' } });
  await waitFor(() => expect(draft).toHaveBeenLastCalledWith(true));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(draft).toHaveBeenLastCalledWith(false));
});

it('parses an allowlist typed with commas, spaces or semicolons', () => {
  expect(parseAllowlist(' A@x.com,@y.org; b@z.com  ')).toEqual(['a@x.com', '@y.org', 'b@z.com']);
});
