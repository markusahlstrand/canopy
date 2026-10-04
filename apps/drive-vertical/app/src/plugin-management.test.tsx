import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PluginManagement } from './plugin-management';
import { setImageViewerEnabled } from './image-viewer';
import { pluginCatalog } from './plugin-catalog';
import { installedPluginManifest } from '@canopy/scope-drive/spec/model';
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

it('clears a Studio draft after confirming discard on close', () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const onOpenChange = vi.fn();
  render(<PluginManagement open onOpenChange={onOpenChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Build a plugin' }));
  expect((screen.getByLabelText('Plugin manifest') as HTMLTextAreaElement).value).not.toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(confirm).toHaveBeenCalled();
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect((screen.getByLabelText('Plugin manifest') as HTMLTextAreaElement).value).toBe('');
  expect((screen.getByLabelText('Plugin source') as HTMLTextAreaElement).value).toBe('');
  confirm.mockRestore();
});
it('records bundled provenance only while catalog manifest and source are unchanged', async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => new Response(JSON.stringify(url.endsWith('/people/access') ? {canManage:false} : url.endsWith('/plugins') && init?.method !== 'PUT' ? {plugins:[]} : {})));
  vi.stubGlobal('fetch',fetcher);
  render(<PluginManagement open onOpenChange={() => {}} />);
  fireEvent.click(screen.getByRole('button',{name:'Review Markdown'}));
  fireEvent.click(screen.getByRole('checkbox',{name:/Approve the capabilities/}));
  fireEvent.click(screen.getByRole('button',{name:'Install plugin'}));
  await waitFor(()=>expect(fetcher.mock.calls.filter(([,init])=>init?.method==='PUT')).toHaveLength(1));
  const request = JSON.parse(fetcher.mock.calls.find(([,init])=>init?.method==='PUT')![1]!.body as string);
  expect(request.provenance).toEqual({kind:'bundled',ref:'@canopy/catalog/markdown-editor',resolved:request.manifest.version});
});
it('shows manifest errors before allowing a plugin install', () => {
  render(<PluginManagement open onOpenChange={() => {}} />);
  fireEvent.click(screen.getByRole('button',{name:'Build a plugin'}));
  fireEvent.change(screen.getByLabelText('Plugin manifest'),{target:{value:'{bad json'}});
  fireEvent.click(screen.getByRole('checkbox',{name:/Approve the capabilities/}));
  expect(screen.getByRole('alert').textContent).toContain('valid JSON');
  expect((screen.getByRole('button',{name:'Install plugin'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Plugin manifest'),{target:{value:JSON.stringify({id:'valid-id',version:'1',capabilities:[],contributes:{viewers:[{id:'text',match:['text/*']}]}})}});
  expect(screen.getByRole('alert').textContent).toContain('name:');
});
it('keeps every bundled catalog manifest compatible with the install schema', () => {
  for (const entry of pluginCatalog) expect(installedPluginManifest.safeParse(entry.manifest).success).toBe(true);
});
