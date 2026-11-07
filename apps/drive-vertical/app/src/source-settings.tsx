import { useEffect, useRef, useState } from 'react';
import { Button, Icon, Input } from '@canopy/ui';
import { connectSource, disconnectSource, getSourceStatus, type SourceLogin, type SourceStatus } from './api';
import { useUnsavedDraft } from './drafts';

export const emptyLogin: SourceLogin = { companyCode: '', user: '', password: '', customerId: '', folder: '' };
const empty = emptyLogin;
/** Enough to try a connection: a3doc itself judges the rest. */
export const loginReady = (login: SourceLogin) => !!login.companyCode.trim() && !!login.user.trim() && !!login.password;
/** The login as the connect route takes it: an empty customer NIF means none. */
export const loginPayload = (login: SourceLogin): SourceLogin => ({ ...login, customerId: login.customerId?.trim() || undefined });

/** The a3doc login fields, shared by space settings and the create dialog. */
export function SourceLoginFields({ value, disabled, onChange }: { value: SourceLogin; disabled: boolean; onChange: (next: SourceLogin) => void }) {
  const field = (key: keyof SourceLogin, label: string, extra: { type?: string; placeholder?: string } = {}) =>
    <label className="block space-y-1"><span className="text-xs text-muted-foreground">{label}</span>
      <Input type={extra.type} placeholder={extra.placeholder} value={value[key] ?? ''} disabled={disabled} autoComplete="off" onChange={event => onChange({ ...value, [key]: event.target.value })}/>
    </label>;
  return <>
    <p className="text-xs text-muted-foreground">The login your gestoría gave you for a3doc. The space then shows that folder’s documents and keeps them in sync.</p>
    {field('companyCode', 'Company code')}{field('user', 'User')}{field('password', 'Password', { type: 'password' })}
    {field('folder', 'a3doc folder', { placeholder: 'Leave empty for every folder' })}
    {field('customerId', 'Customer NIF/CIF for uploads (optional)')}
  </>;
}
const message = (error: unknown) => error instanceof Error ? error.message || 'Could not reach a3doc.' : String(error);
const when = (iso: string) => new Date(iso).toLocaleString();
const documents = (count: number) => `${count} ${count === 1 ? 'document' : 'documents'}`;

/**
 * Why a connected space holds what it holds, in the order worth reading: a failure, then what the
 * last full read found. Shared by space settings and the empty folder, where the question comes up.
 */
export function sourceSyncNote({ source, binding, report }: SourceStatus): { failed: boolean; text: string } | null {
  if (!source) return null;
  if (binding?.lastError && (!binding.lastSyncedAt || binding.lastError.at > binding.lastSyncedAt)) return { failed: true, text: `Last sync failed ${when(binding.lastError.at)}: ${binding.lastError.message}` };
  if (binding && binding.status !== 'active') return { failed: true, text: `The a3doc login needs attention (${binding.status}). Connect again with the current password.` };
  if (!report) return { failed: false, text: binding?.lastSyncedAt ? `Last synced ${when(binding.lastSyncedAt)}.` : 'Not synced yet. Documents appear after the first sync.' };
  if (report.total === 0) return { failed: true, text: `a3doc listed no documents in this folder for this login (checked ${when(report.at)}). Check the folder, and that this user can see it in a3doc.` };
  if (report.skipped > 0) {
    const ids = report.skippedContainers.length ? ` They name a3doc folder ${report.skippedContainers.join(', ')}.` : ' a3doc gave no folder for them.';
    return { failed: true, text: `${report.skipped} of ${documents(report.read)} read were skipped because a3doc files them outside this folder.${ids}` };
  }
  if (!report.complete) return { failed: false, text: `Syncing: read ${report.read} of ${documents(report.total)} so far.` };
  return { failed: false, text: `Last full read ${when(report.at)}: ${report.read} of ${documents(report.total)}, ${report.files} here.` };
}

/**
 * Where this space's files come from (#358): Canopy storage, or one a3doc folder the space
 * mirrors. Connecting and disconnecting take effect at once, apart from the dialog's Save.
 */
export function SourceSettings({ disabled, onChanged, onDraftChange }: { disabled: boolean; onChanged: () => void; onDraftChange?: (drafting: boolean) => void }) {
  const [status, setStatus] = useState<SourceStatus | null>(null);
  const [form, setForm] = useState<SourceLogin | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  /** A login being typed: only Connect sends it, so nothing around this form may discard it unasked. */
  const drafting = !!form && (!!form.user.trim() || !!form.password);
  useUnsavedDraft(drafting);
  useEffect(() => { onDraftChange?.(drafting); return () => onDraftChange?.(false); }, [drafting]);
  const load = () => getSourceStatus().then(next => { if (alive.current) setStatus(next); }).catch(e => { if (alive.current) setError(message(e)); });
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, []);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await work(); if (alive.current) { setForm(null); await load(); onChanged(); } }
    catch (e) { if (alive.current) setError(message(e)); }
    finally { if (alive.current) setBusy(false); }
  };
  const source = status?.source, binding = status?.binding, report = status?.report;
  const note = status ? sourceSyncNote(status) : null;
  const locked = disabled || busy;
  const connect = () => { if (form && !locked && loginReady(form)) void run(() => connectSource(loginPayload(form))); };
  const alert = error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null;
  return <section aria-labelledby="settings-source" className="space-y-2"><h3 id="settings-source" className="text-xs font-medium text-muted-foreground">Source</h3>
    {form ? null : alert}
    {!status ? <p role="status" className="text-sm text-muted-foreground">Loading source…</p> : source ? (
      <div className="space-y-2 rounded-lg border px-3 py-2.5">
        <div className="flex items-start gap-3"><Icon name="link" size={18} className="mt-0.5 text-muted-foreground"/>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">a3doc · {source.account}</p>
            <p className="truncate text-xs text-muted-foreground">Mirrors {source.folder ? `the folder ${source.folder}` : 'every folder'}. {source.canUpload ? 'Uploads go on to a3doc.' : 'This a3doc user can only read, so nothing can be uploaded here.'}</p>
            <p className="text-xs text-muted-foreground">{binding?.lastSyncedAt ? `Last synced ${when(binding.lastSyncedAt)}.` : 'Not synced yet.'}</p>
            {note && (note.failed || report) ? <p className={`text-xs ${note.failed ? 'text-destructive' : 'text-muted-foreground'}`}>{note.text}</p> : null}
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
    {/* These fields sit inside the settings form, where Enter would save the space and not the login. */}
    {form ? <div role="group" aria-label="Connect a3doc" className="space-y-2 rounded-lg border px-3 py-2.5"
      onKeyDown={event => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); connect(); } }}>
      <SourceLoginFields value={form} disabled={locked} onChange={setForm}/>
      {alert}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setForm(null); setError(null); }}>Cancel</Button>
        <Button type="button" size="sm" disabled={locked || !loginReady(form)}
          onClick={connect}>{busy ? 'Connecting…' : 'Connect'}</Button>
      </div>
    </div> : null}
  </section>;
}
