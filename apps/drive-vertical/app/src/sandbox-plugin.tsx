import { useEffect, useRef, useState } from 'react';
import { versionContentUrl, type PluginInstall } from './api';
import { useUnsavedDraft } from './drafts';
import { pluginManifest } from './installed-plugins';
/** Source is imported only inside an opaque-origin iframe, never in the application. */
export function pluginDocument(hosts: string[] = []): string {
  const origins = hosts.filter(host => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)).map(host => `https://${host}`).join(' ');
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob: ${origins}; style-src 'unsafe-inline' ${origins}; img-src data: blob: ${origins}; connect-src ${origins || "'none'"}; font-src data: ${origins}; worker-src blob:; base-uri 'none'; form-action 'none'"><div id="root"></div><script type="module">
  const send=(type,data)=>parent.postMessage({canopyPlugin:true,type,data},'*');
  document.addEventListener('input',()=>send('dirty'),true);
  let started=false;
  addEventListener('message',async event=>{
    if(event.source!==parent || event.data?.type!=='render' || started)return;
    started=true;
    try { const module=await import(URL.createObjectURL(new Blob([event.data.source],{type:'text/javascript'})));
      const render=module.default || module.render;
      if(typeof render!=='function')throw Error('Plugin must export a render function');
      await render({container:document.getElementById('root'),file:event.data.file,fill:true,emit:(action,data)=>send('action',{action,data})});
      send('rendered');
    } catch(error){send('error',String(error?.message || error));}
  });send('ready');</script>`;
}
export function SandboxPlugin({ plugin, file, onSave }: { plugin: PluginInstall; file?: { id: string; versionId: string; name: string; mime: string; size: number | null }; onSave?: (text: string) => Promise<void> }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  useUnsavedDraft(dirty);
  const manifest = pluginManifest(plugin);
  const hosts = manifest.capabilities.filter(cap => cap.kind === 'net:fetch').flatMap(cap => cap.hosts ?? []);
  useEffect(() => {
    const abort = new AbortController(); let ready = false; let saving = false;
    setError(null);
    const timer = window.setTimeout(() => { if (!ready) setError('Plugin did not start. Choose the built-in preview or retry.'); }, 15000);
    const receive = async (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !event.data?.canopyPlugin) return;
      if (event.data.type === 'dirty' && onSave) setDirty(true);
      if (event.data.type === 'error') setError(String(event.data.data).slice(0, 500));
      if (event.data.type === 'action' && event.data.data?.action === 'save' && !saving && manifest.capabilities.some(cap => cap.kind === 'item:write')) {
        if (!onSave) { frame.current?.contentWindow?.postMessage({type: 'canopy:save-result', ok: false, error: 'This file is read-only.'}, '*'); return; }
        const text = event.data.data.data?.content;
        if (typeof text !== 'string' || new TextEncoder().encode(text).length > 200000) { setError('Plugin save must contain text up to 200 KB.'); frame.current?.contentWindow?.postMessage({type:'canopy:save-result',ok:false,error:'Text exceeds the save limit.'}, '*'); return; }
        saving = true;
        try { await onSave(text); setDirty(false); frame.current?.contentWindow?.postMessage({type:'canopy:save-result',ok:true}, '*'); } catch (error) { if (!abort.signal.aborted) { const message = error instanceof Error ? error.message : String(error); setError(message); frame.current?.contentWindow?.postMessage({type:'canopy:save-result',ok:false,error:message}, '*'); } }
        finally { saving = false; }
      }
      if (event.data.type !== 'ready' || ready) return;
      ready = true; window.clearTimeout(timer);
      try {
        let bytes = new ArrayBuffer(0);
        if (file) {
          if (!manifest.capabilities.some(cap => cap.kind === 'item:read')) throw Error('Plugin has no file-read permission.');
          if (file.size == null || file.size > 20000000) throw Error('Plugin previews support files up to 20 MB.');
          const response = await fetch(versionContentUrl(file.id, file.versionId), { signal: abort.signal });
          if (!response.ok) throw Error('Could not load this file version.');
          bytes = await response.arrayBuffer();
          if (bytes.byteLength > 20000000) throw Error('Plugin previews support files up to 20 MB.');
        }
        if (!abort.signal.aborted) frame.current?.contentWindow?.postMessage({ type: 'render', source: plugin.source, file: file ? {name: file.name, mime: file.mime, bytes} : undefined }, '*', [bytes]);
      } catch (error) { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : String(error)); }
    };
    window.addEventListener('message', receive);
    return () => { abort.abort(); clearTimeout(timer); window.removeEventListener('message', receive); };
  }, [plugin.id, plugin.updated_at, file?.id, file?.versionId, onSave]);
  return <>{error ? <p role="alert">{error}</p> : null}<iframe ref={frame} title={manifest.name} sandbox="allow-scripts" srcDoc={pluginDocument(hosts)} className="min-h-96 h-full w-full border-0" /></>;
}
