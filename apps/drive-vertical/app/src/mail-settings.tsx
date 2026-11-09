import { useEffect, useRef, useState } from 'react';
import { Button, Icon, Input } from '@canopy/ui';
import { ApiError, changeSpaceMail, getSpaceMail, whoami, type SpaceMail } from './api';
import { useUnsavedDraft } from './drafts';

/** `a@x.com, @supplier.example` → entries, lowercased; blanks dropped. */
export const parseAllowlist = (text: string) => text.split(/[\s,;]+/).map(entry => entry.trim().toLowerCase()).filter(Boolean);

const message = (error: unknown) => error instanceof Error ? error.message || 'Could not reach the mail service.' : String(error);
const messages = (n: number) => `${n} ${n === 1 ? 'message' : 'messages'}`;

/**
 * "Email to this space" (#357): an address you forward mail to, such as supplier invoices. Each
 * message lands under Mail/ as its own folder holding message.eml and every attachment. Only
 * managers see it (the routes answer 403 to anyone else, and the panel then renders nothing).
 */
export function MailSettings({ disabled, onDraftChange }: { disabled: boolean; onDraftChange?: (drafting: boolean) => void }) {
  const [mail, setMail] = useState<SpaceMail | null>(null);
  const [hidden, setHidden] = useState(false);
  const [allowlist, setAllowlist] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [copied, setCopied] = useState(false);
  const alive = useRef(true);
  /** Senders being typed: only the button sends them, so nothing around this form may discard them unasked. */
  const allowlistStart = useRef<string | null>(null);
  const openEditor = (start: string) => { allowlistStart.current = start; setAllowlist(start); };
  const drafting = allowlist !== null && allowlist !== allowlistStart.current;
  useUnsavedDraft(drafting);
  useEffect(() => { onDraftChange?.(drafting); return () => onDraftChange?.(false); }, [drafting]);
  // 403 is not a manager, 404 an older worker, 503 no hosted platform: nothing to offer. The
  // platform failing is a 502 from the route, which keeps the panel and offers a retry.
  const load = () => {
    setError(null);
    getSpaceMail().then(next => { if (alive.current) setMail(next); })
      .catch(e => { if (!alive.current) return; if (e instanceof ApiError && [403, 404, 503].includes(e.status)) setHidden(true); else setError(message(e)); });
  };
  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; };
  }, []);
  if (hidden) return null;
  const run = async (body: Parameters<typeof changeSpaceMail>[0]) => {
    setBusy(true); setError(null);
    try { const next = await changeSpaceMail(body); if (alive.current) { setMail(next); setAllowlist(null); } }
    catch (e) { if (alive.current) setError(message(e)); }
    finally { if (alive.current) setBusy(false); }
  };
  // Forwarding your own mail is the case this is for, so the list starts with your own address.
  const start = async () => {
    const me = await whoami().catch(() => null);
    if (alive.current) openEditor(me?.user?.email ?? '');
  };
  const copy = async () => {
    if (!mail?.address) return;
    setError(null);
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(mail.address.address);
    } catch {
      if (alive.current) setError('Could not copy the address. Select it and copy it by hand.');
      return;
    }
    if (!alive.current) return;
    setCopied(true); setTimeout(() => { if (alive.current) setCopied(false); }, 1500);
  };
  const locked = disabled || busy;
  const address = mail?.address;
  const alert = error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null;
  const editor = allowlist === null ? null : <div role="group" aria-label="Mail senders" className="space-y-2 rounded-lg border px-3 py-2.5"
    onKeyDown={event => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault(); }}>
    <label className="block space-y-1"><span className="text-xs text-muted-foreground">Who may send</span>
      <Input value={allowlist} disabled={locked} placeholder="me@example.com, @supplier.example" onChange={event => setAllowlist(event.target.value)}/>
    </label>
    <p className="text-xs text-muted-foreground">Addresses, or @domain for anyone there. A sender must prove it is who it says. Leave it empty to accept mail from anyone who knows the address.</p>
    {alert}
    <div className="flex justify-end gap-2">
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setAllowlist(null); setError(null); }}>Cancel</Button>
      <Button type="button" size="sm" disabled={locked} onClick={() => void run({ action: address ? 'rotate' : 'request', allowlist: parseAllowlist(allowlist) })}>
        {busy ? 'Saving…' : address ? 'Save and get a new address' : 'Get an address'}
      </Button>
    </div>
  </div>;
  return <section aria-labelledby="settings-mail" className="space-y-2"><h3 id="settings-mail" className="text-xs font-medium text-muted-foreground">Email to this space</h3>
    {allowlist === null ? alert : null}
    {!mail ? (error ? <Button type="button" variant="outline" size="sm" onClick={load}>Try again</Button> : <p role="status" className="text-sm text-muted-foreground">Loading email…</p>) : address ? (
      <div className="space-y-2 rounded-lg border px-3 py-2.5">
        <div className="flex items-start gap-3"><Icon name="inbox" size={18} className="mt-0.5 text-muted-foreground"/>
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-sm" title={address.address}>{address.address}</p>
            <p className="text-xs text-muted-foreground">Mail forwarded here lands in Mail/, one folder per message, with each attachment as its own file.</p>
            <p className="text-xs text-muted-foreground">{address.allowlist.length ? `Only from ${address.allowlist.join(', ')}.` : 'From anyone who knows the address.'}</p>
            <p className="text-xs text-muted-foreground">{messages(mail.messages)} filed{mail.lastReceivedAt ? `, last ${new Date(mail.lastReceivedAt).toLocaleString()}` : ''}.{address.stats.pending ? ` ${address.stats.pending} on the way.` : ''}{address.stats.rejected ? ` ${address.stats.rejected} refused.` : ''}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => void copy()}>{copied ? 'Copied' : 'Copy address'}</Button>
          <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => openEditor(address.allowlist.join(', '))}>Change senders</Button>
          <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => void run({ action: 'rotate', allowlist: address.allowlist })}>New address</Button>
          <Button type="button" variant="ghost" size="sm" disabled={locked} onClick={() => void run({ action: 'revoke' })}>{busy ? 'Working…' : 'Turn off'}</Button>
        </div>
        {mail.connected ? <p className="text-xs text-destructive">This space now mirrors a connected source, so mail sent here can't be filed until it is disconnected.</p> : null}
        <p className="text-xs text-muted-foreground">A new address stops the old one at once. Mail already filed stays.</p>
      </div>
    ) : mail.connected ? (
      <p className="text-xs text-muted-foreground">This space mirrors a connected source, so it has no folders of its own to file mail into.</p>
    ) : allowlist === null ? (
      <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5"><Icon name="inbox" size={18} className="text-muted-foreground"/>
        <div className="flex-1"><p className="text-sm font-medium">No address</p><p className="text-xs text-muted-foreground">Get an address to forward invoices and other mail into this space.</p></div>
        <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => void start()}>Get an address</Button>
      </div>
    ) : null}
    {editor}
  </section>;
}
