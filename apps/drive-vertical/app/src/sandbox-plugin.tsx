import { useUnsavedDraft, confirmDiscardDrafts } from './drafts';
import { Button } from '@canopy/ui';
import { useEffect, useRef, useState } from 'react';
import { pluginSource, versionContentUrl, type PluginInstall } from './api';
import { pluginManifest } from './installed-plugins';
/** Source is imported only inside an opaque-origin iframe, never in the application. */
export function pluginDocument(hosts: string[] = []): string {
  const origins = hosts.filter(host => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)).map(host => `https://${host}`).join(' ');
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob: ${origins}; style-src 'unsafe-inline' ${origins}; img-src data: blob: ${origins}; connect-src ${origins || "'none'"}; font-src data: ${origins}; worker-src blob:; base-uri 'none'; form-action 'none'"><div id="root"></div><script type="module">
  const send=(type,data)=>parent.postMessage({canopyPlugin:true,type,data},'*');
  document.addEventListener('input',()=>send('dirty'),true);
  let started=false;
  addEventListener('message',async event=>{
    if(event.source!==parent)return;
    if(event.data?.type==='canopy:save-result'){document.getElementById('root').inert=false;return;}
    if(event.data?.type!=='render' || started)return;
    started=true;
    try { const module=await import(URL.createObjectURL(new Blob([event.data.source],{type:'text/javascript'})));
      const render=module.default || module.render;
      if(typeof render!=='function')throw Error('Plugin must export a render function');
      await render({container:document.getElementById('root'),file:event.data.file,fill:true,emit:(action,data)=>{if(action==='save')document.getElementById('root').inert=true;send('action',{action,data});}});
      send('rendered');
    } catch(error){send('error',String(error?.message || error));}
  });send('ready');</script>`;
}
type SandboxProps = {plugin:PluginInstall;file?:{id:string;versionId:string;name:string;mime:string;size:number|null};onSave?:(text:string)=>Promise<void>};
export function SandboxPlugin(props:SandboxProps) {
 const [attempt,setAttempt]=useState(0);
 return <SandboxInstance key={`${props.plugin.id}:${props.plugin.updated_at}:${props.file?.id}:${props.file?.versionId}:${attempt}`} {...props} onRetry={()=>setAttempt(value=>value+1)}/>;
}
function SandboxInstance({plugin,file,onSave,onRetry}:SandboxProps & {onRetry:()=>void}) {
 const frame=useRef<HTMLIFrameElement>(null), loads=useRef(0), retired=useRef(false), abortRef=useRef<AbortController|null>(null), saveRef=useRef(onSave);
 saveRef.current=onSave;
 const [error,setError]=useState<string|null>(null),[blocked,setBlocked]=useState(false),[dirty,setDirty]=useState(false),[savingFile,setSavingFile]=useState(false);
 useUnsavedDraft(dirty);
 const manifest=pluginManifest(plugin),hosts=manifest.capabilities.filter(cap=>cap.kind==='net:fetch').flatMap(cap=>cap.hosts??[]);
 useEffect(()=>{
  retired.current=false;const abort=new AbortController();abortRef.current=abort;let ready=false,saving=false,editRevision=0;
  let timer=window.setTimeout(()=>setError('Plugin did not start. Choose the built-in preview or retry.'),15000);
  abort.signal.addEventListener('abort',()=>clearTimeout(timer));
  const reply=(value:unknown)=>{if(!retired.current)frame.current?.contentWindow?.postMessage(value,'*');};
  const receive=async(event:MessageEvent)=>{
   if(retired.current || event.origin!=='null' || event.source!==frame.current?.contentWindow || !event.data?.canopyPlugin)return;
   if(event.data.type==='dirty' && saveRef.current && manifest.capabilities.some(cap=>cap.kind==='item:write')){editRevision++;setDirty(true);}
   if(event.data.type==='rendered'){clearTimeout(timer);return;}
   if(event.data.type==='error'){clearTimeout(timer);setError(String(event.data.data).slice(0,500));return;}
   if(event.data.type==='action' && event.data.data?.action==='save' && !saving){
    if(!saveRef.current || !manifest.capabilities.some(cap=>cap.kind==='item:write')){reply({type:'canopy:save-result',ok:false,error:'This file is read-only.'});return;}
    const text=event.data.data.data?.content;
    if(typeof text!=='string' || new TextEncoder().encode(text).length>200000){reply({type:'canopy:save-result',ok:false,error:'Text exceeds the 200 KB save limit.'});return;}
    saving=true;setSavingFile(true);const savedRevision=editRevision;
    try{await saveRef.current(text);if(!abort.signal.aborted){if(editRevision===savedRevision)setDirty(false);reply({type:'canopy:save-result',ok:true});}}
    catch(error){if(!abort.signal.aborted){const message=error instanceof Error?error.message:String(error);setError(message);reply({type:'canopy:save-result',ok:false,error:message});}}
    finally{saving=false;if(!abort.signal.aborted)setSavingFile(false);}
   }
   if(event.data.type!=='ready' || ready)return;
   ready=true;clearTimeout(timer);timer=window.setTimeout(()=>setError('Plugin did not finish rendering. Choose the built-in preview.'),15000);
   try{
    if(file && !manifest.capabilities.some(cap=>cap.kind==='item:read'))throw Error('Plugin has no file-read permission.');
    if(file && (file.size==null || file.size>20000000))throw Error('Plugin previews support files up to 20 MB.');
    const loaded=await pluginSource(plugin.id,plugin.updated_at);
    let bytes=new ArrayBuffer(0);
    if(file){const response=await fetch(versionContentUrl(file.id,file.versionId),{signal:abort.signal});if(!response.ok)throw Error('Could not load this file version.');bytes=await response.arrayBuffer();if(bytes.byteLength>20000000)throw Error('Plugin previews support files up to 20 MB.');}
    if(!abort.signal.aborted && !retired.current)frame.current?.contentWindow?.postMessage({type:'render',source:loaded.source,file:file?{name:file.name,mime:file.mime,bytes,writable:!!saveRef.current && manifest.capabilities.some(cap=>cap.kind==='item:write')}:undefined},'*',[bytes]);
   }catch(error){if(!abort.signal.aborted){clearTimeout(timer);setError(error instanceof Error?error.message:String(error));}}
  };
  window.addEventListener('message',receive);
  return()=>{retired.current=true;abort.abort();clearTimeout(timer);window.removeEventListener('message',receive);};
 },[]);
 const loaded=()=>{if(++loads.current>1){retired.current=true;abortRef.current?.abort();setBlocked(true);setError('Plugin navigated away and was stopped.');}};
 return <>{savingFile?<p role="status">Saving plugin edits…</p>:null}{error?<div className="space-y-2"><p role="alert">{error}</p><Button variant="outline" size="sm" onClick={()=>{if(confirmDiscardDrafts())onRetry();}}>Retry plugin</Button></div>:null}{!blocked?<iframe ref={frame} onLoad={loaded} title={manifest.name} inert={savingFile} aria-busy={savingFile} sandbox="allow-scripts" srcDoc={pluginDocument(hosts)} className="min-h-96 h-full w-full border-0"/>:null}</>;
}
