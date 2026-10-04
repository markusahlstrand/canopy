import { SpaceStyleFields } from './space-style-fields';
import type { SpaceSettings } from '../../src/space-settings';
import { useEffect, useRef, useState } from 'react';
import { Button, Input, Icon, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@canopy/ui';
import { requestSpace, spaceRequests, type SpaceRequest } from './api';
/** The platform owns provisioning; the dialog follows its durable result instead of claiming success on enqueue. */
export function CreateSpaceDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (slug: string) => void }) {
  const [icon, setIcon] = useState<SpaceSettings['icon']>('folder'), [color, setColor] = useState<SpaceSettings['color']>('#3b82f6');
  const [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<SpaceRequest | null>(null);
  const active = useRef(true), slug = useRef('');
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (!open || !request || request.status !== 'pending') return;
    let alive = true;
    const check = async () => {
      try {
        const result = (await spaceRequests()).requests.find(value => value.id === request.id);
        if (!alive || !result) return;
        setRequest(result); setError(null);
        if (result.status !== 'pending') slug.current = '';
        if (result.status === 'done') onCreated(result.slug);
      } catch (error) { if (alive) setError(error instanceof Error ? error.message || 'Could not complete the request.' : String(error)); }
    };
    const interval = setInterval(() => void check(), 3000); void check();
    return () => { alive = false; clearInterval(interval); };
  }, [open, request?.id, request?.status, onCreated]);
  const create = async () => {
    if (busy || !name.trim() || request?.status === 'pending') return;
    setBusy(true); setError(null);
    // Keep the slug stable across an uncertain response so retry does not create two spaces.
    slug.current ||= `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 45) || 'space'}-${crypto.randomUUID().slice(0, 8)}`;
    try { const result = await requestSpace(name.trim(), slug.current, {name:name.trim(),icon,color}); if (active.current) setRequest({ ...result, status: 'pending', error: null }); }
    catch (error) { if (active.current) setError(error instanceof Error ? error.message || 'Could not complete the request.' : String(error)); }
    finally { if (active.current) setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}>
    <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[480px]">
      <DialogHeader className="px-5 pt-5">
        <DialogTitle>Create a space</DialogTitle>
        <DialogDescription>A shared place for a family, team, or project. You’ll be its owner.</DialogDescription>
      </DialogHeader>
      <form id="create-space" onSubmit={event => { event.preventDefault(); void create(); }} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
        <section className="space-y-2">
          <label htmlFor="space-name" className="text-xs font-medium text-muted-foreground">Space name</label>
          <Input id="space-name" autoFocus maxLength={100} placeholder="Space name (e.g. Family)" value={name}
            disabled={busy || request?.status === 'pending'}
            onChange={event => { setName(event.target.value); slug.current = ''; if (request?.status !== 'pending') setRequest(null); }} />
          <SpaceStyleFields icon={icon} color={color} disabled={busy || request?.status === 'pending'} onIcon={icon => setIcon(icon as SpaceSettings['icon'])} onColor={color => setColor(color as SpaceSettings['color'])} />
        </section>
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">Storage</h3>
          <div className="flex items-center gap-3 rounded-lg border border-primary bg-primary/5 px-3 py-2.5">
            <Icon name="cloud" size={18} className="text-primary" />
            <div><p className="text-sm font-medium">Canopy storage</p><p className="text-xs text-muted-foreground">Files stay in this install’s storage.</p></div>
          </div>
        </section>
        <section className="space-y-1 rounded-lg border border-dashed p-3">
          <h3 className="text-sm font-medium">People and plugins</h3>
          <p className="text-xs text-muted-foreground">After the space opens, invite members and choose plugins for everyone in its space settings.</p>
        </section>
        {error ? <p role="alert" className="text-sm text-destructive">{error} Your creation request can still complete; check its status before starting another.</p> : null}
        {request ? <p role={request.status === 'failed' ? 'alert' : 'status'} className="rounded-lg bg-muted px-3 py-2 text-sm">{request.status === 'pending' ? 'Creating your space… You can close this dialog and return to check its progress.' : request.status === 'failed' ? `Could not create the space: ${request.error ?? 'The platform refused the request.'}` : 'Space created.'}</p> : null}
      </form>
      <DialogFooter className="border-t px-5 py-3">
        <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>Close</Button>
        <Button type="submit" form="create-space" disabled={busy || !name.trim() || request?.status === 'pending'}>{busy ? 'Requesting…' : request?.status === 'failed' ? 'Retry creation' : 'Create space'}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
