import { useEffect, useState } from 'react';
import { Button, Input, Dialog, DialogContent, DialogHeader, DialogTitle } from '@canopy/ui';
import { getSpaceSettings, updateSpaceSettings } from './api';
import { defaultSpaceSettings, type SpaceSettings } from '../../src/space-settings';
import { SpaceStyleFields } from './space-style-fields';
import { useUnsavedDraft, confirmDiscardDrafts } from './drafts';
export function SpaceSettingsDialog({open,onOpenChange,onSaved}: {open:boolean;onOpenChange:(open:boolean)=>void;onSaved:()=>void}) {
  const [settings,setSettings] = useState<SpaceSettings>(defaultSpaceSettings(''));
  const [initial,setInitial] = useState(''), [busy,setBusy] = useState(false), [loaded,setLoaded] = useState(false), [error,setError] = useState<string|null>(null), [retry,setRetry] = useState(0);
  useUnsavedDraft(open && loaded && JSON.stringify(settings) !== initial);
  useEffect(() => { if (!open) return; let alive = true; setLoaded(false); setError(null); getSpaceSettings().then(settings => { if (alive) {setSettings(settings);setInitial(JSON.stringify(settings));setLoaded(true);} }).catch(error => {if(alive)setError(error instanceof Error ? error.message || 'Could not save or load space settings.' : String(error));}); return () => {alive=false;}; }, [open,retry]);
  const save = async () => { setBusy(true);setError(null);try {const result=await updateSpaceSettings(settings);setSettings(result);setInitial(JSON.stringify(result));onSaved();onOpenChange(false);}catch(error){setError(error instanceof Error ? error.message || 'Could not save or load space settings.' : String(error));}finally{setBusy(false);} };
  return <Dialog open={open} onOpenChange={next => {if(!busy && (next || confirmDiscardDrafts()))onOpenChange(next);}}><DialogContent><DialogHeader><DialogTitle>Space settings</DialogTitle></DialogHeader>{error ? <p role="alert">{error}{!loaded ? <Button onClick={()=>setRetry(value=>value+1)}>Retry settings</Button>:null}</p>:null}{!loaded ? <p>Loading settings…</p>:<form className="space-y-4" onSubmit={event=>{event.preventDefault();if(!busy)void save();}}><label>Space name<Input value={settings.name} maxLength={100} disabled={busy} onChange={event=>setSettings({...settings,name:event.target.value})}/></label><SpaceStyleFields icon={settings.icon} color={settings.color} disabled={busy} onIcon={icon=>setSettings({...settings,icon:icon as SpaceSettings['icon']})} onColor={color=>setSettings({...settings,color:color as SpaceSettings['color']})}/><Button disabled={busy || !settings.name.trim()}>{busy?'Saving…':'Save space'}</Button></form>}</DialogContent></Dialog>;
}
