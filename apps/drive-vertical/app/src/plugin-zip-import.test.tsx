import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {PluginManagement} from './plugin-management';

const zip = vi.hoisted(() => ({source:'export default () => {}'}));
vi.mock('@canopy/plugin-sources', () => ({resolveZipBytes: () => ({
  manifest:{id:'zip-viewer',name:'ZIP viewer',version:'1.0.0',capabilities:[{kind:'item:read'}],contributes:{viewers:[{id:'text',match:['text/*']}]}},
  entry:{code:zip.source},version:'1.0.0',
})}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();zip.source='export default () => {}';});

function archive() {
  const file=new File(['zip'],'viewer.zip',{type:'application/zip'});
  Object.defineProperty(file,'arrayBuffer',{value:async()=>new Uint8Array([1,2,3]).buffer});
  return file;
}

it('reviews a ZIP plugin before installing it with ZIP provenance', async () => {
  const fetcher=vi.fn(async (url:string,init?:RequestInit)=>new Response(JSON.stringify(url.endsWith('/people/access')?{canManage:false}:url.endsWith('/plugins')&&init?.method!=='PUT'?{plugins:[]}:{id:'zip-install'})));
  vi.stubGlobal('fetch',fetcher);
  render(<PluginManagement open onOpenChange={()=>{}}/>);
  fireEvent.click(screen.getByText(/Plugin Studio · import or edit source/));
  fireEvent.change(screen.getByLabelText('Choose plugin ZIP file'),{target:{files:[archive()]}});
  await screen.findByDisplayValue(/zip-viewer/);
  expect((screen.getByRole('button',{name:'Install plugin'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox',{name:/Approve the capabilities/}));
  fireEvent.click(screen.getByRole('button',{name:'Install plugin'}));
  await waitFor(()=>expect(fetcher.mock.calls.some(([,init])=>init?.method==='PUT')).toBe(true));
  const body=JSON.parse(fetcher.mock.calls.find(([,init])=>init?.method==='PUT')![1]!.body as string);
  expect(body.provenance).toEqual({kind:'zip',ref:'viewer.zip',resolved:'1.0.0'});
});
it('rejects a ZIP entry that exceeds the plugin source limit before install', async () => {
  zip.source='x'.repeat(256_001);
  render(<PluginManagement open onOpenChange={()=>{}}/>);
  fireEvent.change(screen.getByLabelText('Choose plugin ZIP file'),{target:{files:[archive()]}});
  expect(await screen.findByText('Plugin source in this ZIP is too large.')).toBeTruthy();
  expect((screen.getByRole('button',{name:'Install plugin'}) as HTMLButtonElement).disabled).toBe(true);
});
it('keeps a Studio draft when ZIP replacement is canceled', () => {
  const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
  render(<PluginManagement open onOpenChange={()=>{}}/>);
  fireEvent.change(screen.getByLabelText('Plugin source'),{target:{value:'my draft'}});
  fireEvent.change(screen.getByLabelText('Choose plugin ZIP file'),{target:{files:[archive()]}});
  expect(confirm).toHaveBeenCalled();
  expect((screen.getByLabelText('Plugin source') as HTMLTextAreaElement).value).toBe('my draft');
});
