import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {PluginManagement} from './plugin-management';

vi.mock('@canopy/plugin-sources', () => ({resolveZipBytes: () => ({
  manifest:{id:'zip-viewer',name:'ZIP viewer',version:'1.0.0',capabilities:[{kind:'item:read'}],contributes:{viewers:[{id:'text',match:['text/*']}]}},
  entry:{code:'export default () => {}'},version:'1.0.0',
})}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it('reviews a ZIP plugin before installing it with ZIP provenance', async () => {
  const fetcher=vi.fn(async (url:string,init?:RequestInit)=>new Response(JSON.stringify(url.endsWith('/people/access')?{canManage:false}:url.endsWith('/plugins')&&init?.method!=='PUT'?{plugins:[]}:{id:'zip-install'})));
  vi.stubGlobal('fetch',fetcher);
  render(<PluginManagement open onOpenChange={()=>{}}/>);
  fireEvent.click(screen.getByText(/Plugin Studio · import or edit source/));
  const archive=new File(['zip'],'viewer.zip',{type:'application/zip'});
  Object.defineProperty(archive,'arrayBuffer',{value:async()=>new Uint8Array([1,2,3]).buffer});
  fireEvent.change(screen.getByLabelText('Choose plugin ZIP file'),{target:{files:[archive]}});
  await screen.findByDisplayValue(/zip-viewer/);
  expect((screen.getByRole('button',{name:'Install plugin'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox',{name:/Approve the capabilities/}));
  fireEvent.click(screen.getByRole('button',{name:'Install plugin'}));
  await waitFor(()=>expect(fetcher.mock.calls.some(([,init])=>init?.method==='PUT')).toBe(true));
  const body=JSON.parse(fetcher.mock.calls.find(([,init])=>init?.method==='PUT')![1]!.body as string);
  expect(body.provenance).toEqual({kind:'zip',ref:'viewer.zip',resolved:'1.0.0'});
});
