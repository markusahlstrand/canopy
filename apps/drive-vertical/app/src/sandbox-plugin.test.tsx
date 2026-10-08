import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen,waitFor} from '@testing-library/react';
import {SandboxPlugin} from './sandbox-plugin';
import type {PluginInstall} from './api';
import {pluginCatalog} from './plugin-catalog';
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
const row:PluginInstall={id:'installed',plugin_id:'editor',principal:'user',source:'export default function(){}',enabled:1,updated_at:'revision',manifest_json:JSON.stringify({id:'editor',name:'Editor',capabilities:[{kind:'item:read'},{kind:'item:write'}],contributes:{viewers:[{id:'text',match:['text/*']}]}})};
it('pins bytes to the requested version and passes the legacy writable flag only for an authorized editor',async()=>{
 const fetcher=vi.fn(async(url:string)=>new Response(url.includes('/source')?JSON.stringify(row):'content'));vi.stubGlobal('fetch',fetcher);const save=vi.fn(async()=>{});
 render(<SandboxPlugin plugin={row} file={{id:'file',versionId:'version',name:'notes.txt',mime:'text/plain',size:7}} onSave={save}/>);
 const frame=screen.getByTitle('Editor') as HTMLIFrameElement;expect(frame.getAttribute('sandbox')).toBe('allow-scripts');const post=vi.spyOn(frame.contentWindow!,'postMessage');
 await act(async()=>window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,origin:'null',data:{canopyPlugin:true,type:'ready'}})));
 await waitFor(()=>expect(post).toHaveBeenCalled());expect(fetcher.mock.calls[1]![0]).toBe('/api/files/file/versions/version/content');expect(post.mock.calls[0]![0].file.writable).toBe(true);
 await act(async()=>window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,origin:'null',data:{canopyPlugin:true,type:'action',data:{action:'save',data:{content:'updated'}}}})));
 expect(save).toHaveBeenCalledExactlyOnceWith('updated');expect(post).toHaveBeenLastCalledWith({type:'canopy:save-result',ok:true},'*');
});
it('declares the old bundled viewers library hosts in catalog manifests for review',()=>{
 expect(pluginCatalog.find(entry=>entry.manifest.id==='markdown-editor')!.manifest.capabilities).toContainEqual({kind:'net:fetch',hosts:['esm.sh','cdn.jsdelivr.net']});
 expect(pluginCatalog.find(entry=>entry.manifest.id==='pdf-viewer')!.manifest.capabilities).toContainEqual({kind:'net:fetch',hosts:['cdn.jsdelivr.net']});
});
it('restarts a failed plugin with a fresh sandbox and source request',async()=>{
 const {fireEvent}=await import('@testing-library/react');
 const fetcher=vi.fn().mockRejectedValueOnce(new Error('Source unavailable')).mockResolvedValue(new Response(JSON.stringify(row)));
 vi.stubGlobal('fetch',fetcher);
 render(<SandboxPlugin plugin={row}/>);
 const first=screen.getByTitle('Editor') as HTMLIFrameElement;
 await act(async()=>window.dispatchEvent(new MessageEvent('message',{source:first.contentWindow,origin:'null',data:{canopyPlugin:true,type:'ready'}})));
 await screen.findByText('Source unavailable');
 fireEvent.click(screen.getByRole('button',{name:'Retry plugin'}));
 const second=screen.getByTitle('Editor') as HTMLIFrameElement;
 expect(second).not.toBe(first);
 await act(async()=>window.dispatchEvent(new MessageEvent('message',{source:second.contentWindow,origin:'null',data:{canopyPlugin:true,type:'ready'}})));
 expect(fetcher).toHaveBeenCalledTimes(2);
 expect(screen.queryByRole('alert')).toBeNull();
});
it('keeps edits made during a pending save marked as unsaved',async()=>{
 const {hasUnsavedDrafts}=await import('./drafts');
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(row))));
 let finish!:()=>void;
 const save=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
 render(<SandboxPlugin plugin={row} onSave={save}/>);
 const frame=screen.getByTitle('Editor') as HTMLIFrameElement;
 const send=(type:string,data?:unknown)=>window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,origin:'null',data:{canopyPlugin:true,type,data}}));
 await act(async()=>{send('dirty');});
 await act(async()=>{send('action',{action:'save',data:{content:'first edit'}});});
 await act(async()=>{send('dirty');});
 await act(async()=>finish());
 expect(hasUnsavedDrafts()).toBe(true);
});
