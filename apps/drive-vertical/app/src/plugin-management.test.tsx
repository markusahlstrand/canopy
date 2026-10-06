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
it('names the selected space before offering space-wide installs', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/plugins') ? { plugins: [] } : { canManage: true }))));
  render(<PluginManagement open onOpenChange={() => {}} spaceName="Family" />);
  expect(screen.getByText(/apply them to “Family”/)).toBeTruthy();
  expect(screen.getByText('Installed for you or applied to Family.')).toBeTruthy();
  expect(await screen.findByRole('button', { name: 'Apply Markdown to Family' })).toBeTruthy();
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
it('finds viewers by file extension and MIME type', () => {
  render(<PluginManagement open onOpenChange={() => {}} />);
  const search = screen.getByLabelText('Find a plugin');
  fireEvent.change(search, { target: { value: '.md' } });
  expect(screen.getByRole('button', { name: 'Review Markdown' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Review PDF Viewer' })).toBeNull();
  fireEvent.change(search, { target: { value: 'application/pdf' } });
  expect(screen.getByRole('button', { name: 'Review PDF Viewer' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Review Markdown' })).toBeNull();
  fireEvent.change(search, { target: { value: 'image/png' } });
  expect(screen.getByRole('button', { name: 'Review Image Viewer' })).toBeTruthy();
  fireEvent.change(search, { target: { value: 'image/tiff' } });
  expect(screen.getByRole('button', { name: 'Review Image Viewer' })).toBeTruthy();
  fireEvent.change(search, { target: { value: 'text/markdown; charset=utf-8' } });
  expect(screen.getByRole('button', { name: 'Review Markdown' })).toBeTruthy();
  fireEvent.change(search, { target: { value: 'report.pdf' } });
  expect(screen.getByRole('button', { name: 'Review PDF Viewer' })).toBeTruthy();
  fireEvent.change(search, { target: { value: '.tex' } });
  expect(screen.queryByRole('button', { name: 'Review Code Editor' })).toBeNull();
  fireEvent.change(search, { target: { value: '.m' } });
  expect(screen.queryByRole('button', { name: 'Review Markdown' })).toBeNull();
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
it('filters installed plugins by personal and space scope', async () => {
  const manifest = (id: string) => JSON.stringify({ id, name: id, version: '1', capabilities: [], contributes: {} });
  const plugins = [
    { id: 'mine', plugin_id: 'personal-viewer', principal: 'user', enabled: 1, source: '', updated_at: '1', manifest_json: manifest('personal-viewer') },
    { id: 'shared', plugin_id: 'space-viewer', principal: 'space', enabled: 1, source: '', updated_at: '1', manifest_json: manifest('space-viewer') },
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/plugins') ? { plugins } : { canManage: true }))));
  render(<PluginManagement open onOpenChange={() => {}} />);
  await screen.findByText('personal-viewer');
  fireEvent.click(screen.getByRole('button', { name: 'Space installs' }));
  expect(screen.getByText('space-viewer')).toBeTruthy();
  expect(screen.queryByText('personal-viewer')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Personal installs' }));
  expect(screen.getByText('personal-viewer')).toBeTruthy();
  expect(screen.queryByText('space-viewer')).toBeNull();
});

it('opens the original damaged manifest for repair', async () => {
  const row = { id: 'damaged-install', plugin_id: 'damaged', principal: 'user', enabled: 1, source: 'export default function() {}', updated_at: 'revision', manifest_json: '{broken' };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/source?') ? row : url.endsWith('/plugins') ? { plugins: [row] } : { canManage: true }))));
  render(<PluginManagement open onOpenChange={() => {}} />);
  await screen.findByText('Invalid manifest: damaged');
  fireEvent.click(screen.getByRole('button', { name: 'Edit source' }));
  await waitFor(() => expect((screen.getByLabelText('Plugin manifest') as HTMLTextAreaElement).value).toBe('{broken'));
  expect(screen.getByText('Manifest must contain valid JSON.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Install plugin' }) as HTMLButtonElement).disabled).toBe(true);
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
it('does not send client-claimed provenance for a catalog install', async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => new Response(JSON.stringify(url.endsWith('/people/access') ? {canManage:false} : url.endsWith('/plugins') && init?.method !== 'PUT' ? {plugins:[]} : {})));
  vi.stubGlobal('fetch',fetcher);
  render(<PluginManagement open onOpenChange={() => {}} />);
  fireEvent.click(screen.getByRole('button',{name:'Review Markdown'}));
  fireEvent.click(screen.getByRole('checkbox',{name:/Approve the capabilities/}));
  fireEvent.click(screen.getByRole('button',{name:'Install plugin'}));
  await waitFor(()=>expect(fetcher.mock.calls.filter(([,init])=>init?.method==='PUT')).toHaveLength(1));
  const request = JSON.parse(fetcher.mock.calls.find(([,init])=>init?.method==='PUT')![1]!.body as string);
  expect(request.provenance).toBeUndefined();
  expect(request.importToken).toBeUndefined();
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
it('loads local manifest and JavaScript files into Studio for review', async () => {
  render(<PluginManagement open onOpenChange={() => {}} />);
  const manifest = new File(['{}'],'canopy.json',{type:'application/json'});
  const source = new File(['export default () => {}'],'index.js',{type:'text/javascript'});
  Object.defineProperty(manifest,'text',{value:async()=>'{"id":"local-plugin"}'});
  Object.defineProperty(source,'text',{value:async()=> 'export default () => {}'});
  fireEvent.change(screen.getByLabelText('Choose plugin manifest file'),{target:{files:[manifest]}});
  fireEvent.change(screen.getByLabelText('Choose plugin source file'),{target:{files:[source]}});
  await waitFor(()=>expect((screen.getByLabelText('Plugin manifest') as HTMLTextAreaElement).value).toContain('local-plugin'));
  expect((screen.getByLabelText('Plugin source') as HTMLTextAreaElement).value).toContain('export default');
  expect((screen.getByRole('button',{name:'Install plugin'}) as HTMLButtonElement).disabled).toBe(true);
});
it('shows file errors beside Studio and clears them when a valid file is selected', async () => {
  render(<PluginManagement open onOpenChange={() => {}} />);
  const input = screen.getByLabelText('Choose plugin source file') as HTMLInputElement;
  fireEvent.change(input,{target:{files:[new File(['x'.repeat(256_001)],'large.js')]}});
  expect(screen.getByText('Plugin source file is too large.')).toBeTruthy();
  const file = new File(['export default () => {}'],'small.js');
  Object.defineProperty(file,'text',{value:async()=> 'export default () => {}'});
  fireEvent.change(input,{target:{files:[file]}});
  await waitFor(()=>expect((screen.getByLabelText('Plugin source') as HTMLTextAreaElement).value).toContain('export default'));
  expect(screen.queryByText('Plugin source file is too large.')).toBeNull();
  expect(input.value).toBe('');
});
it('keeps the latest local file when earlier reads finish later', async () => {
  render(<PluginManagement open onOpenChange={() => {}} />);
  let finishA!: (value:string)=>void, finishB!: (value:string)=>void;
  const a = new File(['a'],'a.js'), b = new File(['b'],'b.js');
  Object.defineProperty(a,'text',{value:()=>new Promise<string>(resolve=>{finishA=resolve;})});
  Object.defineProperty(b,'text',{value:()=>new Promise<string>(resolve=>{finishB=resolve;})});
  const input = screen.getByLabelText('Choose plugin source file');
  fireEvent.change(input,{target:{files:[a]}}); fireEvent.change(input,{target:{files:[b]}});
  await act(async()=>finishB('source B'));
  await act(async()=>finishA('source A'));
  expect((screen.getByLabelText('Plugin source') as HTMLTextAreaElement).value).toBe('source B');
});
it('keeps a source draft when the user cancels file replacement', () => {
  const confirm = vi.spyOn(window,'confirm').mockReturnValue(false);
  render(<PluginManagement open onOpenChange={() => {}} />);
  fireEvent.change(screen.getByLabelText('Plugin source'),{target:{value:'my edited source'}});
  fireEvent.change(screen.getByLabelText('Choose plugin source file'),{target:{files:[new File(['replacement'],'other.js')]}});
  expect((screen.getByLabelText('Plugin source') as HTMLTextAreaElement).value).toBe('my edited source');
  expect(confirm).toHaveBeenCalled();
  confirm.mockRestore();
});
