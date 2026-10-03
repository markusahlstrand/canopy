import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {SpaceSettingsDialog} from './space-settings-dialog';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('saves the loaded space name, icon and color and keeps failed edits available',async()=>{
  const saved=vi.fn(), closed=vi.fn();let fail=true;
  const fetcher=vi.fn(async (_url:string, init?:RequestInit)=>init?.method==='PATCH' ? fail ? new Response('Forbidden',{status:403}):new Response(init.body as string):new Response(JSON.stringify({name:'Family',icon:'home',color:'#10b981'})));
  vi.stubGlobal('fetch',fetcher);render(<SpaceSettingsDialog open onOpenChange={closed} onSaved={saved}/>);
  await screen.findByLabelText('Space name');fireEvent.change(screen.getByLabelText('Space name'),{target:{value:'Our family'}});fireEvent.click(screen.getByRole('button',{name:'Save space'}));
  await screen.findByRole('alert');expect((screen.getByLabelText('Space name')as HTMLInputElement).value).toBe('Our family');expect(closed).not.toHaveBeenCalled();fail=false;
  fireEvent.click(screen.getByRole('button',{name:'Save space'}));await waitFor(()=>expect(saved).toHaveBeenCalledOnce());expect(closed).toHaveBeenCalledWith(false);
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1]!.body as string)).toEqual({name:'Our family',icon:'home',color:'#10b981'});
});
