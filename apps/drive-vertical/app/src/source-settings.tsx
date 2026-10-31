import { useEffect, useRef, useState } from 'react';
import { Button, Icon, Input } from '@canopy/ui';
import { connectSource, disconnectSource, getSourceStatus, type SourceLogin, type SourceStatus } from './api';

const empty: SourceLogin = { companyCode: '', user: '', password: '', customerId: '', folder: '' };
const message = (error: unknown) => error instanceof Error ? error.message || 'Could not reach a3doc.' : String(error);
const when = (iso: string) => new Date(iso).toLocaleString();

/**
 * Where this space's files come from (#358): Canopy storage, or one a3doc folder the space
 * mirrors. Connecting and disconnecting take effect at once, apart from the dialog's Save.
 */
export function SourceSettings({ disabled, onChanged }: { disabled: boolean; onChanged: () => void }) {
  const [status, setStatus] = useState<SourceStatus | null>(null);
  const [form, setForm] = useState<SourceLogin | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const load = () => getSourceStatus().then(next => { if (alive.current) setStatus(next); }).catch(e => { if (alive.current) setError(message(e)); });
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, []);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await work(); if (alive.current) { setForm(null); await load(); onChanged(); } }
    catch (e) { if (alive.current) setError(message(e)); }
    finally { if (alive.current) setBusy(false); }
  };
  const source = status?.source, binding = status?.binding;
  const locked = disabled || busy;
  const field = (key: keyof SourceLogin, label: string, extra: { type?: string; placeholder?: string } = {}) =>
    <label className="block space-y-1"><span className="text-xs text-muted-foreground">{label}</span>
      <Input type={extra.type} placeholder={extra.placeholder} value={form?.[key] ?? ''} disabled={locked} autoComplete="off" onChange={event => setForm(current => ({ ...(current ?? empty), [key]: event.target.value }))}/>
    </label>;
  return <section aria-labelledby="settings-source" className="space-y-2"><h3 id="settings-source" className="text-xs font-medium text-muted-foreground">Source</h3>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {!status ? <p role="status" className="text-sm text-muted-foreground">Loading source…</p> : source ? (
      <div className="space-y-2 rounded-lg border px-3 py-2.5">
        <div className="flex items-start gap-3"><Icon name="link" size={18} className="mt-0.5 text-muted-foreground"/>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">a3doc · {source.account}</p>
            <p className="truncate text-xs text-muted-foreground">Mirrors {source.folder ? `the folder ${source.folder}` : 'every folder'}. {source.canUpload ? 'Uploads go on to a3doc.' : 'This a3doc user can only read, so nothing can be uploaded here.'}</p>
            <p className="text-xs text-muted-foreground">{binding?.lastSyncedAt ? `Last synced ${when(binding.lastSyncedAt)}.` : 'Not synced yet.'}</p>
            {binding?.lastError && (!binding.lastSyncedAt || binding.lastError.at > binding.lastSyncedAt)
              ? <p className="text-xs text-destructive">Last sync failed {when(binding.lastError.at)}: {binding.lastError.message}</p> : null}
            {binding && binding.status !== 'active' ? <p className="text-xs text-destructive">The a3doc login needs attention ({binding.status}). Connect again with the current password.</p> : null}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">Folders and documents here follow a3doc, so they can't be renamed, moved or deleted in Canopy. Disconnecting keeps every file, and the space becomes an ordinary one.</p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => setForm({ ...empty, companyCode: source.account, folder: source.folder })}>Connect again</Button>
          <Button type="button" variant="ghost" size="sm" disabled={locked} onClick={() => void run(disconnectSource)}>{busy && !form ? 'Disconnecting…' : 'Disconnect'}</Button>
        </div>
      </div>
    ) : (
      <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5"><Icon name="cloud" size={18} className="text-muted-foreground"/>
        <div className="flex-1"><p className="text-sm font-medium">Canopy storage</p><p className="text-xs text-muted-foreground">Files stay in this install’s storage.</p></div>
        {!form ? <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => setForm(empty)}>Connect a3doc</Button> : null}
      </div>
    )}
    {form ? <div role="group" aria-label="Connect a3doc" className="space-y-2 rounded-lg border px-3 py-2.5">
      <p className="text-xs text-muted-foreground">The login your gestoría gave you for a3doc. The space then shows that folder’s documents and keeps them in sync.</p>
      {field('companyCode', 'Company code')}{field('user', 'User')}{field('password', 'Password', { type: 'password' })}
      {field('folder', 'a3doc folder', { placeholder: 'Leave empty for every folder' })}
      {field('customerId', 'Customer NIF/CIF for uploads (optional)')}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setForm(null); setError(null); }}>Cancel</Button>
        <Button type="button" size="sm" disabled={locked || !form.companyCode.trim() || !form.user.trim() || !form.password}
          onClick={() => void run(() => connectSource({ ...form, customerId: form.customerId?.trim() || undefined }))}>{busy ? 'Connecting…' : 'Connect'}</Button>
      </div>
    </div> : null}
  </section>;
}
