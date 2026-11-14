import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Input, Icon, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@canopy/ui';
import { currentSite, deleteSite, getSpaceSettings, selectSite, updateSpaceSettings } from './api';
import { defaultSpaceSettings, type SpaceSettings } from '../../src/space-settings';
import { SpaceStyleFields } from './space-style-fields';
import { SourceSettings } from './source-settings';
import { MailSettings } from './mail-settings';
import { useUnsavedDraft, confirmDiscardDrafts } from './drafts';
import { CategoriesEditor } from './categories-editor';
import { FlowsDialog } from './flows-dialog';
export function SpaceSettingsDialog({open,onOpenChange,onSaved}: {open:boolean;onOpenChange:(open:boolean)=>void;onSaved:()=>void}) {
  const [settings,setSettings] = useState<SpaceSettings>(defaultSpaceSettings(''));
  const [initial,setInitial] = useState(''), [busy,setBusy] = useState(false), [loaded,setLoaded] = useState(false), [error,setError] = useState<string|null>(null), [retry,setRetry] = useState(0), [sourceDraft,setSourceDraft] = useState(false), [mailDraft,setMailDraft] = useState(false), [flowsOpen,setFlowsOpen] = useState(false);
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
  const remove = async () => {
    const slug = currentSite();
    if (!slug) return;
    const ticket = generation.current;
    setBusy(true); setError(null);
    try {
      await deleteSite(slug);
      // The selected space is gone: drop the selection and land on the install's home space.
      selectSite(null);
      const url = new URL(window.location.href);
      for (const key of ['site', 'path', 'folder', 'file', 'view']) url.searchParams.delete(key);
      url.hash = '';
      window.location.replace(url);
    } catch (error) {
      if (generation.current === ticket) { setError(error instanceof Error ? error.message || 'Could not delete this space.' : String(error)); setBusy(false); }
    }
  };
  // Flows reference categories by id, so they see only the saved list: an unsaved category's id can still change.
  const savedCategories = useMemo<NonNullable<SpaceSettings['categories']>>(() => {
    try { return (JSON.parse(initial || '{}') as SpaceSettings).categories ?? []; } catch { return []; }
  }, [initial]);
  return <>
  <FlowsDialog open={flowsOpen} onOpenChange={setFlowsOpen} categories={savedCategories}/>
  <Dialog open={open} onOpenChange={next => {if(!busy && (next || confirmDiscardDrafts()))onOpenChange(next);}}>
    <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[480px]">
      <DialogHeader className="px-5 pt-5"><DialogTitle>Space settings</DialogTitle><DialogDescription>Choose how this space appears to its members.</DialogDescription></DialogHeader>
      <div className="min-h-0 overflow-y-auto px-5 py-4">
        {error ? <p role="alert" className="mb-3 text-sm text-destructive">{error}{!loaded ? <Button variant="outline" size="sm" onClick={()=>setRetry(value=>value+1)}>Retry settings</Button>:null}</p>:null}
        {!loaded ? <p role="status" className="text-sm text-muted-foreground">Loading settings…</p> : <form id="space-settings-form" className="space-y-5" onSubmit={event=>{event.preventDefault();if(!busy&&!sourceDraft&&!mailDraft)void save();}}>
          <section className="space-y-2"><label htmlFor="settings-space-name" className="text-xs font-medium text-muted-foreground">Space name</label>
            <Input id="settings-space-name" value={settings.name} maxLength={100} disabled={busy} onChange={event=>setSettings({...settings,name:event.target.value})}/>
            <SpaceStyleFields icon={settings.icon} color={settings.color} disabled={busy} onIcon={icon=>setSettings({...settings,icon:icon as SpaceSettings['icon']})} onColor={color=>setSettings({...settings,color:color as SpaceSettings['color']})}/>
            <div aria-label="Space appearance preview" className="flex items-center gap-3 rounded-lg border p-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg" style={{color:settings.color,backgroundColor:`${settings.color}1f`}}><Icon name={settings.icon} size={20}/></span>
              <div className="min-w-0"><p className="text-xs text-muted-foreground">Preview in spaces</p><p className="truncate text-sm font-medium">{settings.name.trim() || 'Untitled space'}</p></div>
            </div>
          </section>
          <section className="space-y-2"><h3 className="text-xs font-medium text-muted-foreground">Document AI</h3>
            <label htmlFor="settings-auto-label" className="flex items-start gap-3 rounded-lg border px-3 py-2.5">
              <Checkbox id="settings-auto-label" className="mt-0.5" checked={settings.autoLabel ?? false} disabled={busy} onCheckedChange={checked=>setSettings({...settings,autoLabel:checked===true||undefined})}/>
              <span><span className="block text-sm font-medium">Label new documents automatically</span><span className="block text-xs text-muted-foreground">An AI model reads the text of each new document (uploaded, synced from a source or mailed in) and adds a type label and a short description. Labels and descriptions people wrote are kept.</span></span>
            </label>
            <div className="space-y-1 pt-1">
              <h4 className="text-xs font-medium">Categories</h4>
              <p className="text-xs text-muted-foreground">Document AI also puts each document in one of these, and flows can act on the category. A category someone picks by hand is never changed.</p>
              <CategoriesEditor value={settings.categories ?? []} savedIds={savedCategories.map(c=>c.id)} disabled={busy} onChange={categories=>setSettings({...settings,categories:categories.length?categories:undefined})}/>
            </div>
          </section>
          <section className="space-y-2"><h3 className="text-xs font-medium text-muted-foreground">Flows</h3>
            <div className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5">
              <span><span className="block text-sm font-medium">Act on documents as they arrive</span><span className="block text-xs text-muted-foreground">For example: copy every bank statement that arrives here into your gestoría's a3doc space.</span></span>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={()=>setFlowsOpen(true)}>Flows…</Button>
            </div>
          </section>
          <SourceSettings disabled={busy} onChanged={onSaved} onDraftChange={setSourceDraft}/>
          <MailSettings disabled={busy} onDraftChange={setMailDraft}/>
          {currentSite() ? <DeleteSpace name={JSON.parse(initial || '{}').name ?? ''} disabled={busy} onDelete={() => void remove()}/> : null}
        </form>}
      </div>
      <DialogFooter className="border-t px-5 py-3">{sourceDraft||mailDraft?<p role="status" className="mr-auto self-center text-xs text-muted-foreground">{sourceDraft?'Connect or cancel the source login first.':'Save or cancel the email senders first.'}</p>:null}<Button type="button" variant="ghost" disabled={busy} onClick={() => {if(confirmDiscardDrafts())onOpenChange(false);}}>Cancel</Button><Button type="submit" form="space-settings-form" disabled={!loaded || busy || sourceDraft || mailDraft || !settings.name.trim()}>{busy?'Saving…':'Save space'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
  </>;
}

/** Deleting is permanent for its members, so the name is typed out before the button arms. */
function DeleteSpace({name,disabled,onDelete}: {name:string;disabled:boolean;onDelete:()=>void}) {
  const [confirming,setConfirming] = useState(false), [typed,setTyped] = useState('');
  return <section aria-label="Delete space" className="space-y-2 rounded-lg border border-destructive/40 p-3">
    <h3 className="text-xs font-medium text-destructive">Delete space</h3>
    <p className="text-xs text-muted-foreground">Removes this space and everything in it for every member. This cannot be undone.</p>
    {!confirming ? <Button type="button" variant="outline" size="sm" className="text-destructive" disabled={disabled} onClick={()=>setConfirming(true)}><Icon name="trash" size={14}/> Delete space…</Button> : <div className="space-y-2">
      <label htmlFor="delete-space-confirm" className="block text-xs text-muted-foreground">Type <span className="font-medium text-foreground">{name}</span> to confirm.</label>
      <Input id="delete-space-confirm" value={typed} autoComplete="off" disabled={disabled} onChange={event=>setTyped(event.target.value)}/>
      <div className="flex gap-2">
        <Button type="button" variant="destructive" size="sm" disabled={disabled || !name || typed.trim() !== name} onClick={onDelete}>{disabled ? 'Deleting…' : 'Delete this space'}</Button>
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={()=>{setConfirming(false);setTyped('');}}>Keep it</Button>
      </div>
    </div>}
  </section>;
}
