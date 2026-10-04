import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PluginManagement } from './plugin-management';
import { setImageViewerEnabled } from './image-viewer';
afterEach(() => { cleanup(); setImageViewerEnabled(true); vi.unstubAllGlobals(); });
it('manages enabled state and explains file access and matching contributions', () => {
  setImageViewerEnabled(true); render(<PluginManagement open onOpenChange={() => {}} />);
  expect(screen.getByText('Handles: image/*')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Disable image viewer' }));
  expect(screen.getByText('No optional viewers are enabled.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Enable image viewer' })); expect(screen.getByText('Handles: image/*')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Find a plugin'), { target: { value: 'absent' } }); expect(screen.getByText('No available plugins match this search.')).toBeTruthy();
});
it('restores bundled catalog review and source authoring', () => {
  render(<PluginManagement open onOpenChange={() => {}} />);
  expect(screen.getAllByText(/Listed hosts serve code that runs with the opened file/)).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: 'Editors' }));
  expect(screen.getByRole('button', { name: 'Review Markdown' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Review PDF/i })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'All' }));
  fireEvent.click(screen.getByRole('button', {name:'Review Markdown'}));
  expect((screen.getByLabelText('Plugin manifest') as HTMLTextAreaElement).value).toContain('markdown-editor');
  expect((screen.getByLabelText('Plugin source') as HTMLTextAreaElement).value).toContain('export default');
  expect(screen.getByRole('button', {name:'Install plugin'})).toBeTruthy();
});

it('shows an installed-plugin empty state only after loading succeeds', async () => {
  let finishLoading!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/plugins')
    ? new Promise<Response>(resolve => { finishLoading = resolve; })
    : Promise.resolve(new Response(JSON.stringify({ canManage: false })))));
  render(<PluginManagement open onOpenChange={() => {}} />);
  expect(screen.getByText('Loading installed plugins…')).toBeTruthy();
  expect(screen.queryByText('No plugins installed yet.')).toBeNull();

  await act(async () => finishLoading(new Response(JSON.stringify({ plugins: [] }))));
  expect(screen.getByText('No plugins installed yet.')).toBeTruthy();
});

it('does not claim there are no installed plugins when loading fails', async () => {
  vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/plugins')
    ? Promise.reject(new Error('offline'))
    : Promise.resolve(new Response(JSON.stringify({ canManage: false })))));
  render(<PluginManagement open onOpenChange={() => {}} />);
  expect((await screen.findByRole('alert')).textContent).toContain('Could not load installed plugins.');
  expect(screen.queryByText('No plugins installed yet.')).toBeNull();
});
