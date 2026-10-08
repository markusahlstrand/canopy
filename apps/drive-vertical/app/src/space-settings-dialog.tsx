import { useEffect, useRef, useState } from 'react';
import { Button, Input, Icon, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@canopy/ui';
import { getSpaceSettings, updateSpaceSettings } from './api';
import { defaultSpaceSettings, type SpaceSettings } from '../../src/space-settings';
import { SpaceStyleFields } from './space-style-fields';
import { useUnsavedDraft, confirmDiscardDrafts } from './drafts';
export function SpaceSettingsDialog({open,onOpenChange,onSaved}: {open:boolean;onOpenChange:(open:boolean)=>void;onSaved:()=>void}) {
  const [settings,setSettings] = useState<SpaceSettings>(defaultSpaceSettings(''));
  const [initial,setInitial] = useState(''), [busy,setBusy] = useState(false), [loaded,setLoaded] = useState(false), [error,setError] = useState<string|null>(null), [retry,setRetry] = useState(0);
  useUnsavedDraft(open && loaded && JSON.stringify(settings) !== initial);
  const generation = useRef(0);
  useEffect(() => {
    const ticket = ++generation.current;
    setBusy(false);
    if (!open) return;
    setLoaded(false); setError(null);
    getSpaceSettings().then(settings => {
      if (generation.current !== ticket) return;
      setSettings(settings); setInitial(JSON.stringify(settings)); setLoaded(true);
    }).catch(error => {
      if (generation.current === ticket) setError(error instanceof Error ? error.message || 'Could not save or load space settings.' : String(error));
    });
    return () => { generation.current++; };
  }, [open, retry]);
  const save = async () => {
    const ticket = generation.current;
    setBusy(true); setError(null);
    try {
      const result = await updateSpaceSettings(settings);
      if (generation.current !== ticket) return;
      setSettings(result); setInitial(JSON.stringify(result)); onSaved(); onOpenChange(false);
    } catch (error) {
      if (generation.current === ticket) setError(error instanceof Error ? error.message || 'Could not save or load space settings.' : String(error));
    } finally { if (generation.current === ticket) setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={next => {if(!busy && (next || confirmDiscardDrafts()))onOpenChange(next);}}>
    <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[480px]">
      <DialogHeader className="px-5 pt-5"><DialogTitle>Space settings</DialogTitle><DialogDescription>Choose how this space appears to its members.</DialogDescription></DialogHeader>
      <div className="min-h-0 overflow-y-auto px-5 py-4">
        {error ? <p role="alert" className="mb-3 text-sm text-destructive">{error}{!loaded ? <Button variant="outline" size="sm" onClick={()=>setRetry(value=>value+1)}>Retry settings</Button>:null}</p>:null}
        {!loaded ? <p role="status" className="text-sm text-muted-foreground">Loading settings…</p> : <form id="space-settings-form" className="space-y-5" onSubmit={event=>{event.preventDefault();if(!busy)void save();}}>
          <section className="space-y-2"><label htmlFor="settings-space-name" className="text-xs font-medium text-muted-foreground">Space name</label>
            <Input id="settings-space-name" value={settings.name} maxLength={100} disabled={busy} onChange={event=>setSettings({...settings,name:event.target.value})}/>
            <SpaceStyleFields icon={settings.icon} color={settings.color} disabled={busy} onIcon={icon=>setSettings({...settings,icon:icon as SpaceSettings['icon']})} onColor={color=>setSettings({...settings,color:color as SpaceSettings['color']})}/>
            <div aria-label="Space appearance preview" className="flex items-center gap-3 rounded-lg border p-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg" style={{color:settings.color,backgroundColor:`${settings.color}1f`}}><Icon name={settings.icon} size={20}/></span>
              <div className="min-w-0"><p className="text-xs text-muted-foreground">Preview in spaces</p><p className="truncate text-sm font-medium">{settings.name.trim() || 'Untitled space'}</p></div>
            </div>
          </section>
          <section className="space-y-2"><h3 className="text-xs font-medium text-muted-foreground">Storage</h3><div className="flex items-center gap-3 rounded-lg border px-3 py-2.5"><Icon name="cloud" size={18} className="text-muted-foreground"/><div><p className="text-sm font-medium">Canopy storage</p><p className="text-xs text-muted-foreground">Files stay in this install’s storage.</p></div></div></section>
        </form>}
      </div>
      <DialogFooter className="border-t px-5 py-3"><Button type="button" variant="ghost" disabled={busy} onClick={() => {if(confirmDiscardDrafts())onOpenChange(false);}}>Cancel</Button><Button type="submit" form="space-settings-form" disabled={!loaded || busy || !settings.name.trim()}>{busy?'Saving…':'Save space'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
