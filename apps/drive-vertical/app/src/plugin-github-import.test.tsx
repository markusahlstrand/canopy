import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {PluginManagement} from './plugin-management';

afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});

it('loads a GitHub plugin for review before install',async()=>{
  const manifest={id:'github-viewer',name:'GitHub viewer',version:'1',capabilities:[{kind:'item:read'}],contributes:{viewers:[{id:'text',match:['text/*']}]}};
  const fetcher=vi.fn(async(url:string,init?:RequestInit)=>new Response(JSON.stringify(url.endsWith('/people/access')?{canManage:false}:url.endsWith('/plugins')&&init?.method!=='PUT'?{plugins:[]}:url.endsWith('/plugin-import/github')?{manifest,source:'export default () => {}',provenance:{kind:'github',ref:'owner/repo@main',resolved:'a'.repeat(40)}}:{})));
  vi.stubGlobal('fetch',fetcher);
  render(<PluginManagement open onOpenChange={()=>{}}/>);
  fireEvent.click(screen.getByText(/Plugin Studio · import or edit source/));
  fireEvent.change(screen.getByLabelText('GitHub repository'),{target:{value:'owner/repo'}});
  fireEvent.click(screen.getByRole('button',{name:'Review GitHub plugin'}));
  await screen.findByDisplayValue(/github-viewer/);
  expect((screen.getByRole('button',{name:'Install plugin'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox',{name:/Approve the capabilities/}));
  fireEvent.click(screen.getByRole('button',{name:'Install plugin'}));
  await waitFor(()=>expect(fetcher.mock.calls.some(([,init])=>init?.method==='PUT')).toBe(true));
  const body=JSON.parse(fetcher.mock.calls.find(([,init])=>init?.method==='PUT')![1]!.body as string);
  expect(body.provenance).toEqual({kind:'github',ref:'owner/repo@main',resolved:'a'.repeat(40)});
});
it('keeps a Studio draft when GitHub import is canceled', () => {
  const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
  const fetcher=vi.fn(async (url:string)=>new Response(JSON.stringify(url.endsWith('/people/access')?{canManage:false}:{plugins:[]})));
  vi.stubGlobal('fetch',fetcher);
  render(<PluginManagement open onOpenChange={()=>{}}/>);
  fireEvent.change(screen.getByLabelText('Plugin source'),{target:{value:'my draft'}});
  fireEvent.change(screen.getByLabelText('GitHub repository'),{target:{value:'owner/repo'}});
  fireEvent.click(screen.getByRole('button',{name:'Review GitHub plugin'}));
  expect(confirm).toHaveBeenCalled();
  expect((screen.getByLabelText('Plugin source') as HTMLTextAreaElement).value).toBe('my draft');
  expect(fetcher.mock.calls.some(([url])=>url.endsWith('/plugin-import/github'))).toBe(false);
});
