import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DriveScreen } from './drive';
vi.mock('./file-table', () => ({ FileTable: ({ onOpen }: { onOpen: (file: unknown) => void }) => <>
  <button onClick={() => onOpen({ id: 'a', isFolder: false })}>Open A</button><button onClick={() => onOpen({ id: 'b', isFolder: false })}>Open B</button>
</> }));
vi.mock('./command-palette', () => ({ CommandPalette: ({ onOpenFile }: { onOpenFile: (file: unknown) => void }) => <button onClick={() => onOpenFile({ id: 'b', isFolder: false })}>Palette B</button> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('guards table, palette, and close boundaries, but lets a saved editor close without prompting', async () => {
  let saved = false;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') { saved = true; return new Response('{}'); }
    if (url.includes('/content')) return new Response(saved ? 'saved' : 'old');
    if (url === '/api/files/a' || url === '/api/files/b') return new Response(JSON.stringify({ file: { id: url.slice(-1), name: url.slice(-1).toUpperCase() }, version: { id: saved ? 'v2' : 'v1', mime: 'text/plain', source: 'blob' }, canWrite: true }));
    return new Response(JSON.stringify(url === '/api/sites' ? { sites: [] } : url.endsWith('/access') ? { canManage: false } : []));
  });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<DriveScreen onError={() => {}} auth={{ user: {} }} onSignIn={() => {}} onSignOut={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open A' }));
  await screen.findByRole('button', { name: 'Edit text' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit text' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'File text' }), { target: { value: 'draft' } });
  for (const name of ['Open B', 'Palette B', 'Close preview']) {
    fireEvent.click(screen.getByRole('button', { name }));
    expect(screen.getByDisplayValue('draft')).toBeTruthy();
  }
  expect(confirm).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByRole('button', { name: 'Save text' }));
  await screen.findByText('saved');
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'File text' })).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
  expect(screen.queryByLabelText('Preview')).toBeNull();
  expect(confirm).toHaveBeenCalledTimes(3);
});
