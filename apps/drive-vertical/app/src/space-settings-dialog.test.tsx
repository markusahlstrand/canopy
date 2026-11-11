import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {SpaceSettingsDialog} from './space-settings-dialog';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('saves the loaded space name, icon and color and keeps failed edits available',async()=>{
  const saved=vi.fn(), closed=vi.fn();let fail=true;
  const fetcher=vi.fn(async (_url:string, init?:RequestInit)=>init?.method==='PATCH' ? fail ? new Response('Forbidden',{status:403}):new Response(init.body as string):new Response(JSON.stringify({name:'Family',icon:'home',color:'#10b981'})));
  vi.stubGlobal('fetch',fetcher);render(<SpaceSettingsDialog open onOpenChange={closed} onSaved={saved}/>);
  await screen.findByLabelText('Space name');fireEvent.change(screen.getByLabelText('Space name'),{target:{value:'Our family'}});
  expect(screen.getByLabelText('Space appearance preview').textContent).toContain('Our family');
  fireEvent.click(screen.getByRole('button',{name:'Save space'}));
  await screen.findByRole('alert');expect((screen.getByLabelText('Space name')as HTMLInputElement).value).toBe('Our family');expect(closed).not.toHaveBeenCalled();fail=false;
  fireEvent.click(screen.getByRole('button',{name:'Save space'}));await waitFor(()=>expect(saved).toHaveBeenCalledOnce());expect(closed).toHaveBeenCalledWith(false);
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1]!.body as string)).toEqual({name:'Our family',icon:'home',color:'#10b981'});
});
it('will not save over an a3doc login still being typed',async()=>{
  const closed=vi.fn();
  const fetcher=vi.fn(async (url:string, init?:RequestInit)=>url.endsWith('/source/status')?Response.json({source:null,binding:null,report:null}):init?.method==='PATCH'?new Response(init.body as string):Response.json({name:'Family',icon:'home',color:'#10b981'}));
  vi.stubGlobal('fetch',fetcher);render(<SpaceSettingsDialog open onOpenChange={closed} onSaved={()=>{}}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Connect a3doc'}));
  const save=screen.getByRole('button',{name:'Save space'})as HTMLButtonElement;expect(save.disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('Password'),{target:{value:'pw'}});
  await screen.findByText('Connect or cancel the source login first.');expect(save.disabled).toBe(true);
  fireEvent.submit(screen.getByLabelText('Space name').closest('form')!);
  expect(fetcher.mock.calls.some(call=>call[1]?.method==='PATCH')).toBe(false);expect(closed).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole('group',{name:'Connect a3doc'})).getByRole('button',{name:'Cancel'}));
  await waitFor(()=>expect(save.disabled).toBe(false));
});
