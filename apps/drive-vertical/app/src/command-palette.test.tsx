import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CommandPalette } from './command-palette';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const props = { open: true, onOpenChange: vi.fn(), files: [], onNavigate: vi.fn(), onOpenFile: vi.fn(), onUpload: vi.fn() };
it('distinguishes failed search from no matches and retries the same query', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce(new Response(JSON.stringify({ hits: [] })));
  vi.stubGlobal('fetch', fetch);
  render(<CommandPalette {...props} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'budget' } });
  expect(screen.getByRole('status').textContent).toBe('Searching…');
  await screen.findByText('Connection lost');
  expect(screen.queryByText('No results found.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry search' }));
  await screen.findByText('No results found.');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
});
it('retires a pending answer when the palette closes', async () => {
  let finish!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { finish = resolve; })));
  const view = render(<CommandPalette {...props} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'budget' } });
  await vi.waitFor(() => expect(finish).toBeDefined());
  view.rerender(<CommandPalette {...props} open={false} />);
  finish(new Response(JSON.stringify({ hits: [{ id: 'old', name: 'Old result', via: 'name' }] })));
  view.rerender(<CommandPalette {...props} />);
  expect(screen.queryByText('Old result')).toBeNull();
});
