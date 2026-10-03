import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen,waitFor} from '@testing-library/react';
import {SandboxPlugin} from './sandbox-plugin';
import type {PluginInstall} from './api';
import {pluginCatalog} from './plugin-catalog';
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
const row:PluginInstall={id:'installed',plugin_id:'editor',principal:'user',source:'export default function(){}',enabled:1,updated_at:'revision',manifest_json:JSON.stringify({id:'editor',name:'Editor',capabilities:[{kind:'item:read'},{kind:'item:write'}],contributes:{viewers:[{id:'text',match:['text/*']}]}})};
it('pins bytes to the requested version and passes the legacy writable flag only for an authorized editor',async()=>{
 const fetcher=vi.fn(async(_url:string)=>new Response('content'));vi.stubGlobal('fetch',fetcher);const save=vi.fn(async()=>{});
 render(<SandboxPlugin plugin={row} file={{id:'file',versionId:'version',name:'notes.txt',mime:'text/plain',size:7}} onSave={save}/>);
 const frame=screen.getByTitle('Editor') as HTMLIFrameElement;expect(frame.getAttribute('sandbox')).toBe('allow-scripts');const post=vi.spyOn(frame.contentWindow!,'postMessage');
 await act(async()=>window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{canopyPlugin:true,type:'ready'}})));
 await waitFor(()=>expect(post).toHaveBeenCalled());expect(fetcher.mock.calls[0]![0]).toBe('/api/files/file/versions/version/content');expect(post.mock.calls[0]![0].file.writable).toBe(true);
 await act(async()=>window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{canopyPlugin:true,type:'action',data:{action:'save',data:{content:'updated'}}}})));
 expect(save).toHaveBeenCalledExactlyOnceWith('updated');expect(post).toHaveBeenLastCalledWith({type:'canopy:save-result',ok:true},'*');
});
it('declares the old bundled viewers library hosts in catalog manifests for review',()=>{
 expect(pluginCatalog.find(entry=>entry.manifest.id==='markdown-editor')!.manifest.capabilities).toContainEqual({kind:'net:fetch',hosts:['esm.sh','cdn.jsdelivr.net']});
 expect(pluginCatalog.find(entry=>entry.manifest.id==='pdf-viewer')!.manifest.capabilities).toContainEqual({kind:'net:fetch',hosts:['cdn.jsdelivr.net']});
});
