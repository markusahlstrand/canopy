import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {SandboxPlugin} from './sandbox-plugin';
import type {PluginInstall} from './api';
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();});
const plugin=(read=true):PluginInstall=>({id:'plugin',plugin_id:'viewer',principal:'user',manifest_json:JSON.stringify({name:'Viewer',capabilities:read?[{kind:'item:read'}]:[],contributes:{viewers:[{id:'v',match:['text/*']}]}}),enabled:1,updated_at:'revision'});
const file={id:'file',versionId:'version',name:'file.txt',mime:'text/plain',size:4};
const message=(source:Window|null,type='ready',origin='null')=>window.dispatchEvent(new MessageEvent('message',{source,origin,data:{canopyPlugin:true,type}}));
it('ignores foreign frames and refuses file bytes without read capability',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);render(<SandboxPlugin plugin={plugin(false)} file={file}/>);const frame=screen.getByTitle('Viewer') as HTMLIFrameElement;expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
 await act(async()=>message(window));expect(fetcher).not.toHaveBeenCalled();await act(async()=>message(frame.contentWindow));await screen.findByText('Plugin has no file-read permission.');expect(fetcher).not.toHaveBeenCalled();
});
it('loads only the chosen plugin and immutable file revision, remounts revisions, and retires navigation',async()=>{
 const fetcher=vi.fn(async(url:string)=>new Response(url.includes('/source')?JSON.stringify({...plugin(),source:'export default function(){}'}):'file'));vi.stubGlobal('fetch',fetcher);
 const view=render(<SandboxPlugin plugin={plugin()} file={file}/>);const frame=screen.getByTitle('Viewer') as HTMLIFrameElement;await act(async()=>message(frame.contentWindow));await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));expect(fetcher.mock.calls.map(([url])=>url)).toEqual(['/api/plugins/plugin/source?revision=revision','/api/files/file/versions/version/content']);
 view.rerender(<SandboxPlugin plugin={{...plugin(),updated_at:'new'}} file={file}/>);const next=screen.getByTitle('Viewer') as HTMLIFrameElement;expect(next).not.toBe(frame);fireEvent.load(next);fireEvent.load(next);expect(screen.queryByTitle('Viewer')).toBeNull();await act(async()=>message(next.contentWindow));expect(fetcher).toHaveBeenCalledTimes(2);
});
