import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {PeopleDialog} from './people-dialog';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('sends the selected server-offered editor role on invitation',async()=>{
  const fetcher=vi.fn(async(url:string,init?:RequestInit)=>new Response(JSON.stringify(url.endsWith('/invites') ? init?.method==='POST' ? {principal:'invite',email:null,acceptUrl:'https://example.test/claim'} : {roles:['viewer','editor','owner','member'],invites:[]} : {people:[]})));
  vi.stubGlobal('fetch',fetcher);render(<PeopleDialog open onOpenChange={()=>{}}/>);
  await waitFor(()=>expect((screen.getByLabelText('Invitation role') as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Invitation role'),{target:{value:'editor'}});fireEvent.click(screen.getByRole('button',{name:'Invite'}));
  await waitFor(()=>expect(fetcher.mock.calls.some(([,init])=>init?.method==='POST')).toBe(true));
  const call=fetcher.mock.calls.find(([,init])=>init?.method==='POST')!;expect(JSON.parse(call[1]!.body as string).roleKey).toBe('editor');
});
