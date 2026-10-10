import { useEffect, useRef, useState } from 'react';
import { Button, Input, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@canopy/ui';
import { createAppPassword, listAppPasswords, revokeAppPassword, webdavUrl, type AppPassword } from './api';

const message = (error: unknown, fallback: string) => error instanceof Error ? error.message || fallback : String(error);
const when = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** Copy text, reporting whether it worked so the button can say so. */
function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, value: string) => {
    if (!navigator.clipboard) { setCopied(null); return; }
    void navigator.clipboard.writeText(value).then(() => setCopied(key), () => setCopied(null));
  };
  return { copied, copy };
}

/**
 * Connect a WebDAV client (#299). Finder and Explorer cannot sign in through the browser,
 * so each one gets its own password here. The password is shown once and can be revoked
 * at any time; it reaches the same spaces and folders as this login.
 */
export function AppPasswordsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [passwords, setPasswords] = useState<AppPassword[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; password: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const { copied, copy } = useCopy();
  const generation = useRef(0);

  useEffect(() => {
    const ticket = ++generation.current;
    if (!open) { setCreated(null); setName(''); setBusy(false); setRevoking(null); return; }
    setPasswords(null); setError(null);
    listAppPasswords().then(result => {
      if (generation.current === ticket) setPasswords(result.passwords);
    }).catch(error => {
      if (generation.current === ticket) setError(message(error, 'Could not load app passwords.'));
    });
    return () => { generation.current++; };
  }, [open, retry]);

  const create = async () => {
    const ticket = generation.current;
    setBusy(true); setError(null);
    try {
      const result = await createAppPassword(name.trim());
      if (generation.current !== ticket) return;
      const { password, ...row } = result;
      setCreated({ name: row.name, password });
      setPasswords(list => [row, ...(list ?? [])]);
      setName('');
    } catch (error) {
      if (generation.current === ticket) setError(message(error, 'Could not create the app password.'));
    } finally {
      if (generation.current === ticket) setBusy(false);
    }
  };

  const revoke = async (row: AppPassword) => {
    const ticket = generation.current;
    setRevoking(row.id); setError(null);
    try {
      await revokeAppPassword(row.id);
      if (generation.current !== ticket) return;
      setPasswords(list => list?.filter(item => item.id !== row.id) ?? null);
    } catch (error) {
      if (generation.current === ticket) setError(message(error, `Could not revoke ${row.name}.`));
    } finally {
      if (generation.current === ticket) setRevoking(null);
    }
  };

  const address = webdavUrl();
  return <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }}>
    <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[520px]">
      <DialogHeader className="px-5 pt-5">
        <DialogTitle>Connect with WebDAV</DialogTitle>
        <DialogDescription>Open your spaces in Finder, File Explorer or another WebDAV app. Each app signs in with its own password, which you can revoke here.</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 space-y-5 overflow-y-auto px-5 py-4">
        <section className="space-y-2">
          <label htmlFor="webdav-address" className="text-xs font-medium text-muted-foreground">Server address</label>
          <div className="flex gap-2">
            <Input id="webdav-address" readOnly value={address} onFocus={event => event.currentTarget.select()} />
            <Button type="button" variant="outline" onClick={() => copy('address', address)}>{copied === 'address' ? 'Copied' : 'Copy'}</Button>
          </div>
          <p className="text-xs text-muted-foreground">Use any user name, such as your email, and an app password below. Every space you can open appears as a folder, and folders shared directly with you appear under “Shared with me”.</p>
        </section>

        {created ? <section role="status" aria-label="Created app password" className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
          <p className="text-sm font-medium">Password for {created.name}</p>
          <div className="flex gap-2">
            <Input aria-label={`App password for ${created.name}`} readOnly value={created.password} className="font-mono text-xs" onFocus={event => event.currentTarget.select()} />
            <Button type="button" variant="outline" onClick={() => copy('password', created.password)}>{copied === 'password' ? 'Copied' : 'Copy'}</Button>
          </div>
          <p className="text-xs text-muted-foreground">Copy it now. It won’t be shown again.</p>
        </section> : null}

        <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (!busy && name.trim()) void create(); }}>
          <label htmlFor="app-password-name" className="text-xs font-medium text-muted-foreground">New app password</label>
          <div className="flex gap-2">
            <Input id="app-password-name" placeholder="e.g. Finder on my MacBook" value={name} maxLength={60} disabled={busy} onChange={event => setName(event.target.value)} />
            <Button type="submit" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create'}</Button>
          </div>
        </form>

        {error ? <p role="alert" className="text-sm text-destructive">{error}{passwords === null ? <> <Button variant="outline" size="sm" onClick={() => setRetry(value => value + 1)}>Retry</Button></> : null}</p> : null}

        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">Your app passwords</h3>
          {passwords === null ? (error ? null : <p role="status" className="text-sm text-muted-foreground">Loading app passwords…</p>)
            : passwords.length === 0 ? <p className="text-sm text-muted-foreground">No app passwords yet.</p>
            : <ul className="divide-y rounded-lg border">
              {passwords.map(row => <li key={row.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{row.name}</p>
                  <p className="text-xs text-muted-foreground">Created {when(row.created_at)} · {row.last_used_at ? `Last used ${when(row.last_used_at)}` : 'Never used'}</p>
                </div>
                <Button type="button" variant="outline" size="sm" aria-label={`Revoke ${row.name}`} disabled={revoking !== null} onClick={() => void revoke(row)}>{revoking === row.id ? 'Revoking…' : 'Revoke'}</Button>
              </li>)}
            </ul>}
        </section>
      </div>
      <DialogFooter className="border-t px-5 py-3"><Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>Done</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
