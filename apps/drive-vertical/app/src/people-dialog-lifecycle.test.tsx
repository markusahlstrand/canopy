import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PeopleDialog } from './people-dialog';
import * as api from './api';
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it.each(['success','failure'])('keeps an invitation %s from a previous dialog visit out of the new visit',async outcome=>{
 vi.spyOn(api,'listPeople').mockResolvedValue({people:[]});
 const list=vi.spyOn(api,'listInvites').mockResolvedValue({invites:[],roles:['viewer']});
 let resolve!: (value: Awaited<ReturnType<typeof api.createInvite>>)=>void;
 let reject!: (error: Error)=>void;
 vi.spyOn(api,'createInvite').mockImplementation(()=>new Promise((yes,no)=>{resolve=yes;reject=no;}));
 const view=render(<PeopleDialog open onOpenChange={()=>{}}/>);
 await screen.findByRole('button',{name:'Invite'});
 await act(async()=>{});
 fireEvent.change(screen.getByRole('combobox',{name:'Email'}),{target:{value:'test@example.com'}});
 fireEvent.click(screen.getByRole('button',{name:'Invite'}));
 view.rerender(<PeopleDialog open={false} onOpenChange={()=>{}}/>);
 view.rerender(<PeopleDialog open onOpenChange={()=>{}}/>);
 await act(async()=>{});
 const reads=list.mock.calls.length;
 await act(async()=>{if(outcome==='success')resolve({principal:'invited',roleKey:'viewer',email:'test@example.com',acceptUrl:'https://example.com/private-invite'});else reject(new Error('Old visit failed'));});
 expect(screen.queryByDisplayValue('https://example.com/private-invite')).toBeNull();
 expect(screen.queryByText('Old visit failed')).toBeNull();
 // A success changed the server, so the new visit reads again; a failure changed nothing.
 expect(list).toHaveBeenCalledTimes(outcome==='success'?reads+1:reads);
 expect((screen.getByRole('combobox',{name:'Email'}) as HTMLInputElement).value).toBe('');
 expect(screen.getByRole('button',{name:'Invite'}).hasAttribute('disabled')).toBe(false);
});
it.each(['remove','withdraw'])('refreshes a new visit after an old %s completes, without its busy or error state',async operation=>{
 const person={principal:'alice',name:'Alice',email:'alice@example.com',seen_at:''};
 let done=false;
 vi.spyOn(api,'listPeople').mockImplementation(async()=>({people:operation==='remove'&&!done?[person]:[]}));
 const list=vi.spyOn(api,'listInvites').mockImplementation(async()=>({invites:operation==='withdraw'&&!done?[{principal:'alice',roleKey:'viewer',email:'alice@example.com',createdAt:''}]:[],roles:['viewer']}));
 let finish!:()=>void;
 if(operation==='remove') vi.spyOn(api,'removePerson').mockImplementation(()=>new Promise(resolve=>{finish=()=>{done=true;resolve({principal:'alice',revoked:1,unbound:1});};}));
 else vi.spyOn(api,'revokeInvite').mockImplementation(()=>new Promise<void>(resolve=>{finish=()=>{done=true;resolve();};}));
 const view=render(<PeopleDialog open onOpenChange={()=>{}}/>);
 if(operation==='remove'){
  fireEvent.click(await screen.findByRole('button',{name:'Remove Alice'}));
  fireEvent.click(screen.getByRole('button',{name:'Confirm'}));
 }else fireEvent.click(await screen.findByRole('button',{name:'Withdraw the invitation for alice@example.com'}));
 view.rerender(<PeopleDialog open={false} onOpenChange={()=>{}}/>);
 view.rerender(<PeopleDialog open onOpenChange={()=>{}}/>);
 await act(async()=>{});
 // The new visit's own read went out before the server changed, so Alice is still listed.
 expect(screen.getByText(operation==='remove'?'Alice':'alice@example.com')).toBeTruthy();
 const reads=list.mock.calls.length;
 await act(async()=>finish());
 expect(list).toHaveBeenCalledTimes(reads+1);
 expect(screen.queryByText(operation==='remove'?'Alice':'alice@example.com')).toBeNull();
 expect(screen.getByRole('button',{name:'Invite'}).hasAttribute('disabled')).toBe(false);
});
it('does not read while closed when an old visit\'s action completes',async()=>{
 vi.spyOn(api,'listPeople').mockResolvedValue({people:[]});
 const list=vi.spyOn(api,'listInvites').mockResolvedValue({invites:[{principal:'alice',roleKey:'viewer',email:'alice@example.com',createdAt:''}],roles:['viewer']});
 let finish!:()=>void;
 vi.spyOn(api,'revokeInvite').mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
 const view=render(<PeopleDialog open onOpenChange={()=>{}}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Withdraw the invitation for alice@example.com'}));
 view.rerender(<PeopleDialog open={false} onOpenChange={()=>{}}/>);
 const reads=list.mock.calls.length;
 await act(async()=>finish());
 expect(list).toHaveBeenCalledTimes(reads);
});
