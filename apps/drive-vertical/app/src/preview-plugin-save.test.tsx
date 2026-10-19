import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen,waitFor} from '@testing-library/react';
import {PreviewPanel} from './preview';
import {publishPlugins} from './installed-plugins';
import type {PluginInstall} from './api';
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();publishPlugins([]);});

const plugin:PluginInstall={id:'installed',plugin_id:'locked-notes',principal:'user',source:'',enabled:1,updated_at:'rev',manifest_json:JSON.stringify({id:'locked-notes',name:'Locked Notes',capabilities:[{kind:'item:read'},{kind:'item:write'}],contributes:{viewers:[{id:'locked',match:['.locked']}]}})};

/** A drive holding one .locked file whose version advances on every save, or when `bump` says another writer did. */
function drive(){
 let current='v1';
 const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{
  if(init?.method==='PUT'){current=`v${Number(current.slice(1))+1}`;return Response.json({id:'file',current_version_id:current},{status:201});}
  if(url.includes('/plugins'))return Response.json({plugins:[plugin]});
  return Response.json({file:{id:'file',name:'diary.locked',current_version_id:current},version:{id:current,mime:'application/octet-stream',source:'blob',size:10},canWrite:true});
 });
 vi.stubGlobal('fetch',fetcher);
 return {fetcher,bump:()=>{current=`v${Number(current.slice(1))+1}`;}};
}
const frame=()=>screen.getByTitle('Locked Notes') as HTMLIFrameElement;
const fromPlugin=(target:HTMLIFrameElement,data:unknown)=>window.dispatchEvent(new MessageEvent('message',{source:target.contentWindow,origin:'null',data:{canopyPlugin:true,...data as object}}));

it('opens a .locked file in its plugin and keeps that plugin mounted across its own saves',async()=>{
 const {fetcher}=drive();
 publishPlugins([plugin]);
 render(<PreviewPanel fileId="file" onClose={()=>{}} onError={()=>{}}/>);
 await waitFor(()=>expect(frame()).toBeTruthy());
 expect(screen.queryByRole('option',{name:'Built-in preview'})).toBeNull();
 const first=frame();const post=vi.spyOn(first.contentWindow!,'postMessage');
 await act(async()=>fromPlugin(first,{type:'action',data:{action:'save',data:{content:'{"format":"canopy-locked","cipher":{"iv":"a"},"data":"b"}'}}}));
 await waitFor(()=>expect(post).toHaveBeenCalledWith({type:'canopy:save-result',ok:true},'*'));
 expect(fetcher.mock.calls.some(([url,init])=>init?.method==='PUT' && String(url).includes('expectedVersion=v1'))).toBe(true);
 expect(frame()).toBe(first);
 // The next save compares against the version the first one produced.
 await act(async()=>fromPlugin(first,{type:'action',data:{action:'save',data:{content:'{"format":"canopy-locked","cipher":{"iv":"c"},"data":"d"}'}}}));
 await waitFor(()=>expect(fetcher.mock.calls.some(([url,init])=>init?.method==='PUT' && String(url).includes('expectedVersion=v2'))).toBe(true));
 expect(frame()).toBe(first);
});

it('still remounts the plugin on a version someone else wrote',async()=>{
 const {bump}=drive();
 publishPlugins([plugin]);
 const view=render(<PreviewPanel fileId="file" listed={{name:'diary.locked',currentVersionId:'v1'}} onClose={()=>{}} onError={()=>{}}/>);
 await waitFor(()=>expect(frame()).toBeTruthy());
 const first=frame();
 bump();
 view.rerender(<PreviewPanel fileId="file" listed={{name:'diary.locked',currentVersionId:'v2'}} onClose={()=>{}} onError={()=>{}}/>);
 await waitFor(()=>expect(frame()).not.toBe(first));
});
