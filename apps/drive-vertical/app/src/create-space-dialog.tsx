import { useEffect, useRef, useState } from 'react';
import { Button, Input, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@canopy/ui';
import { requestSpace, spaceRequests, type SpaceRequest } from './api';
/** The platform owns provisioning; the dialog follows its durable result instead of claiming success on enqueue. */
export function CreateSpaceDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (slug: string) => void }) {
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
    try { const result = await requestSpace(name.trim(), slug.current); if (active.current) setRequest({ ...result, status: 'pending', error: null }); }
    catch (error) { if (active.current) setError(error instanceof Error ? error.message || 'Could not complete the request.' : String(error)); }
    finally { if (active.current) setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}><DialogContent>
    <DialogHeader><DialogTitle>Create a space</DialogTitle><DialogDescription>A shared drive with its own files and members. You will own the new space.</DialogDescription></DialogHeader>
    <form onSubmit={event => { event.preventDefault(); void create(); }} className="space-y-3">
      <label className="block">Space name<Input autoFocus maxLength={100} value={name} disabled={busy || request?.status === 'pending'} onChange={event => setName(event.target.value)} /></label>
      <p className="text-sm text-muted-foreground">Files use this install's Canopy storage. Invite members after the space opens.</p>
      {error ? <p role="alert">{error} Your creation request can still complete; check its status before starting another.</p> : null}
      {request ? <p role={request.status === 'failed' ? 'alert' : 'status'}>{request.status === 'pending' ? 'Creating your space… You can close this dialog and return to check its progress.' : request.status === 'failed' ? `Could not create the space: ${request.error ?? 'The platform refused the request.'}` : 'Space created.'}</p> : null}
      <Button type="submit" disabled={busy || !name.trim() || request?.status === 'pending'}>{busy ? 'Requesting…' : request?.status === 'failed' ? 'Retry creation' : 'Create space'}</Button>
    </form>
  </DialogContent></Dialog>;
}
