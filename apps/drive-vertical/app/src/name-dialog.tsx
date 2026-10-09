import { useRef, useState } from 'react';
import { Button, Input, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@canopy/ui';

/** Keep a proposed name available until the server accepts it. */
export function NameDialog({ title, initial, confirm, onCancel, onConfirm }: {
  title: string; initial: string; confirm: string;
  onCancel: () => void; onConfirm: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const trimmed = name.trim();
  const submit = async () => {
    if (!trimmed || running.current) return;
    running.current = true; setBusy(true); setError(null);
    try { await onConfirm(trimmed); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { running.current = false; setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !running.current) onCancel(); }}>
    <DialogContent className="sm:max-w-sm">
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>A name is one segment: no slashes, and not . or ..</DialogDescription></DialogHeader>
      <form onSubmit={event => { event.preventDefault(); void submit(); }} className="space-y-4">
        <Input autoFocus aria-label={title} value={name} disabled={busy} onChange={event => { setName(event.currentTarget.value); setError(null); }} />
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onCancel}>Cancel</Button>
          <Button type="submit" size="sm" disabled={busy || !trimmed}>{busy ? 'Saving…' : confirm}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
