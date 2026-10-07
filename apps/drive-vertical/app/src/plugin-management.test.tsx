import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PluginManagement } from './plugin-management';
import { setImageViewerEnabled } from './image-viewer';
import { pluginCatalog } from './plugin-catalog';
import { installedPluginManifest } from '@canopy/scope-drive/spec/model';
import { publishPlugins } from './installed-plugins';
afterEach(() => { cleanup(); publishPlugins([]); setImageViewerEnabled(true); vi.unstubAllGlobals(); });
it('manages enabled state and explains file access and matching contributions', () => {
  setImageViewerEnabled(true); render(<PluginManagement open onOpenChange={() => {}} />);
  expect(screen.getByText('Handles: image/*')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Disable image viewer' }));
  expect(screen.getByText('No optional viewers are enabled.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Enable image viewer' })); expect(screen.getByText('Handles: image/*')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Find a plugin'), { target: { value: 'absent' } }); expect(screen.getByText('No available plugins match this search.')).toBeTruthy();
});
it('lists active runtime viewers alongside bundled viewers', async () => {
  setImageViewerEnabled(false);
  const plugins = [{ id: 'md-install', plugin_id: 'md-viewer', principal: 'space', enabled: 1, source: '', updated_at: '1',
    manifest_json: JSON.stringify({ id: 'md-viewer', name: 'Markdown viewer', version: '1', capabilities: [{ kind: 'item:read' }], contributes: { viewers: [{ id: 'md', title: 'Markdown preview', match: ['.md'] }] } }) }];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/plugins') ? { plugins } : { canManage: false }))));
  render(<PluginManagement open onOpenChange={() => {}} />);
  expect(await screen.findByText('Markdown preview', { exact: false })).toBeTruthy();
  expect(screen.getAllByText('Handles: .md')).toHaveLength(2);
  expect(screen.queryByText('No optional viewers are enabled.')).toBeNull();
  fireEvent.change(screen.getByLabelText('Find a plugin'), { target: { value: 'space' } });
  expect(screen.getByText('Markdown preview', { exact: false })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Find a plugin'), { target: { value: 'personal' } });
  expect(screen.queryByText('Markdown preview', { exact: false })).toBeNull();
});
it('filters individual viewers within a multi-viewer plugin', async () => {
  setImageViewerEnabled(false);
  const plugins = [{ id: 'multi', plugin_id: 'multi-viewer', principal: 'space', enabled: 1, source: '', updated_at: '1',
    manifest_json: JSON.stringify({ id: 'multi-viewer', name: 'Mixed viewer', version: '1', capabilities: [{ kind: 'item:read' }],
      contributes: { viewers: [{ id: 'md', title: 'Markdown preview', match: ['.md'] }, { id: 'pdf', title: 'PDF preview', match: ['.pdf'] }] } }) }];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/plugins') ? { plugins } : { canManage: false }))));
  render(<PluginManagement open onOpenChange={() => {}} />);
  expect(await screen.findByText('PDF preview', { exact: false })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Find a plugin'), { target: { value: '.pdf' } });
  expect(screen.getByText('PDF preview', { exact: false })).toBeTruthy();
  expect(screen.queryByText('Markdown preview', { exact: false })).toBeNull();
  fireEvent.change(screen.getByLabelText('Find a plugin'), { target: { value: 'space' } });
  expect(screen.getByText('Markdown preview', { exact: false })).toBeTruthy();
});
it('names the selected space before offering space-wide installs', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/plugins') ? { plugins: [] } : { canManage: true }))));
  render(<PluginManagement open onOpenChange={() => {}} spaceName="Family" />);
  expect(screen.getByText(/apply them to “Family”/)).toBeTruthy();
  expect(screen.getByText('Installed for you or applied to Family.')).toBeTruthy();
  expect(await screen.findByRole('button', { name: 'Apply Markdown to Family' })).toBeTruthy();
});
it('shows disabled and damaged catalog installs with their actual scope', async () => {
  const id = pluginCatalog.find(entry => entry.manifest.name === 'Markdown')!.manifest.id;
  const plugins = [
    { id: 'personal', plugin_id: id, principal: 'user', enabled: 0, updated_at: '1', manifest_json: JSON.stringify(pluginCatalog.find(entry => entry.manifest.id === id)!.manifest) },
    { id: 'space', plugin_id: id, principal: 'space', enabled: 1, updated_at: '1', manifest_json: '{broken' },
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/plugins') ? { plugins } : { canManage: true }))));
  render(<PluginManagement open onOpenChange={() => {}} spaceName="Family" />);
  expect(await screen.findByText('Disabled for you')).toBeTruthy();
  expect(screen.getByText('Needs repair in Family')).toBeTruthy();
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
it('requires approval again after the JavaScript source changes', () => {
  render(<PluginManagement open onOpenChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Build a plugin' }));
  const approval = screen.getByRole('checkbox', { name: /Approve the capabilities/ }) as HTMLInputElement;
  fireEvent.click(approval);
  expect(approval.checked).toBe(true);
  expect((screen.getByRole('button', { name: 'Install plugin' }) as HTMLButtonElement).disabled).toBe(false);

  fireEvent.change(screen.getByLabelText('Plugin source'), { target: { value: 'export default function changed() {}' } });
  expect(approval.checked).toBe(false);
  expect((screen.getByRole('button', { name: 'Install plugin' }) as HTMLButtonElement).disabled).toBe(true);
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

it('does not offer to enable a disabled install whose manifest needs repair', async () => {
  const row = { id: 'damaged-install', plugin_id: 'damaged', principal: 'user', enabled: 0, source: '', updated_at: 'revision', manifest_json: '{broken' };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/plugins') ? { plugins: [row] } : { canManage: false }))));
  render(<PluginManagement open onOpenChange={() => {}} />);
  await screen.findByText('Invalid manifest: damaged');
  expect((screen.getByRole('button', { name: 'Repair to enable' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Edit source' })).toBeTruthy();
});

it('does not claim there are no installed plugins when loading fails', async () => {
  vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/plugins')
    ? Promise.reject(new Error('offline'))
    : Promise.resolve(new Response(JSON.stringify({ canManage: false })))));
  render(<PluginManagement open onOpenChange={() => {}} />);
  expect((await screen.findByRole('alert')).textContent).toContain('Could not load installed plugins.');
  expect(screen.queryByText('No plugins installed yet.')).toBeNull();
});
it('keeps a previous plugin list visible but read-only when refresh fails', async () => {
  const row = { id: 'cached', plugin_id: 'cached-viewer', principal: 'user', enabled: 1, updated_at: '1',
    manifest_json: JSON.stringify({ id: 'cached-viewer', name: 'Cached viewer', version: '1', capabilities: [{ kind: 'item:read' }], contributes: { viewers: [{ id: 'text', match: ['text/plain'] }] } }) };
  publishPlugins([row]);
  vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/plugins')
    ? Promise.reject(new Error('offline'))
    : Promise.resolve(new Response(JSON.stringify({ canManage: true })))));
  render(<PluginManagement open onOpenChange={() => {}} />);
  await screen.findByText('Showing the last plugin list. Changes are unavailable until it refreshes.');
  expect(screen.getAllByText('Cached viewer').length).toBeGreaterThan(0);
  expect((screen.getByRole('button', { name: 'Disable' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Edit source' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Build a plugin' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Approve the capabilities/ }));
  expect((screen.getByRole('button', { name: 'Install plugin' }) as HTMLButtonElement).disabled).toBe(true);
});

it('retries a failed plugin list without closing Studio', async () => {
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (!url.endsWith('/plugins')) return Promise.resolve(new Response(JSON.stringify({ canManage: false })));
    return ++reads === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(new Response(JSON.stringify({ plugins: [] })));
  }));
  render(<PluginManagement open onOpenChange={() => {}} />);
  await screen.findByText('Could not load installed plugins.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry installed plugins' }));
  await screen.findByText('No plugins installed yet.');
  expect(screen.queryByRole('button', { name: 'Retry installed plugins' })).toBeNull();
  expect(reads).toBe(2);
});
it('keeps installs read-only when a completed change cannot refresh the list', async () => {
  const row = { id: 'viewer', plugin_id: 'viewer', principal: 'user', enabled: 1, updated_at: '1',
    manifest_json: JSON.stringify({ id: 'viewer', name: 'Viewer', version: '1', capabilities: [], contributes: {} }) };
  let reads = 0;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/plugins') && init?.method !== 'PUT') {
      if (++reads === 2) throw new Error('offline');
      return new Response(JSON.stringify({ plugins: [{ ...row, enabled: reads === 1 ? 1 : 0 }] }));
    }
    if (url.endsWith('/people/access')) return new Response(JSON.stringify({ canManage: false }));
    return new Response(JSON.stringify(row));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<PluginManagement open onOpenChange={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
  expect((await screen.findByRole('alert')).textContent).toContain('change was sent');
  expect((screen.getByRole('button', { name: 'Disable' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry installed plugins' }));
  expect(await screen.findByRole('button', { name: 'Enable' })).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Enable' }) as HTMLButtonElement).disabled).toBe(false);
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
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
it('clears an old import error when opening a different Studio source', () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<PluginManagement open onOpenChange={() => {}} />);
  const input = screen.getByLabelText('Choose plugin source file');
  fireEvent.change(input, { target: { files: [new File(['x'.repeat(256_001)], 'large.js')] } });
  expect(screen.getByText('Plugin source file is too large.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Review Markdown' }));
  expect(screen.queryByText('Plugin source file is too large.')).toBeNull();
  fireEvent.change(input, { target: { files: [new File(['x'.repeat(256_001)], 'large.js')] } });
  expect(screen.getByText('Plugin source file is too large.')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Plugin source'), { target: { value: 'export default () => {}' } });
  expect(screen.queryByText('Plugin source file is too large.')).toBeNull();
  confirm.mockRestore();
});
it('requires fresh approval after a replacement file cannot be read', () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<PluginManagement open onOpenChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', {name:'Review Markdown'}));
  fireEvent.click(screen.getByRole('checkbox', {name:/Approve the capabilities/}));
  expect((screen.getByRole('button', {name:'Install plugin'}) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('Choose plugin source file'), {target:{files:[new File(['x'.repeat(256_001)], 'too-large.js')]}});
  expect(screen.getByText('Plugin source file is too large.')).toBeTruthy();
  expect((screen.getByRole('checkbox', {name:/Approve the capabilities/}) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole('button', {name:'Install plugin'}) as HTMLButtonElement).disabled).toBe(true);
  confirm.mockRestore();
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
