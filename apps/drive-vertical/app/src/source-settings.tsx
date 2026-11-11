import { useEffect, useRef, useState } from 'react';
import { Button, Icon, Input } from '@canopy/ui';
import { connectSource, disconnectSource, getSourceStatus, syncSource, type QontoLogin, type SourceLogin, type SourceStatus, type SourceSyncOutcome } from './api';
import { useUnsavedDraft } from './drafts';

export const emptyLogin: SourceLogin = { companyCode: '', user: '', password: '', customerId: '', folder: '' };
const empty = emptyLogin;
/** Enough to try a connection: a3doc itself judges the rest. */
export const loginReady = (login: SourceLogin) => !!login.companyCode.trim() && !!login.user.trim() && !!login.password;
/** The login as the connect route takes it: an empty customer NIF means none. */
export const loginPayload = (login: SourceLogin): SourceLogin => ({ ...login, customerId: login.customerId?.trim() || undefined });

export const emptyQontoLogin: QontoLogin = { provider: 'canopy.qonto', login: '', secretKey: '' };
export const isQontoLogin = (login: SourceLogin | QontoLogin): login is QontoLogin => 'secretKey' in login;
export const qontoLoginReady = (login: QontoLogin) => !!login.login.trim() && !!login.secretKey.trim();
/** What a source is called to the person connecting it. */
export const sourceLabel = (provider: string | undefined) => provider === 'canopy.qonto' ? 'Qonto' : 'a3doc';

/** What a **Sync now** did, in a sentence. */
export function syncOutcomeNote(o: SourceSyncOutcome, label = 'a3doc'): { failed: boolean; text: string } {
  const more = o.pending ? ' More is left; it continues on the next sync.' : '';
  switch (o.outcome) {
    case 'landed': return { failed: false, text: `Synced: new or changed documents arrived.${more}` };
    case 'unchanged': return { failed: false, text: `Synced: nothing changed in ${label}.${more}` };
    case 'in-progress': return { failed: false, text: 'A sync is already running. Documents appear as it lands them.' };
    case 'failed': return { failed: true, text: `Sync failed: ${o.error ?? 'the platform gave no reason.'}` };
  }
}

/** How often the panel re-reads the status until the first sync has finished. */
const FIRST_SYNC_POLL_MS = 10_000;

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
/** The Qonto API key fields, shared by space settings and the create dialog. */
export function QontoLoginFields({ value, disabled, onChange }: { value: QontoLogin; disabled: boolean; onChange: (next: QontoLogin) => void }) {
  const field = (key: 'login' | 'secretKey', label: string, type?: string) =>
    <label className="block space-y-1"><span className="text-xs text-muted-foreground">{label}</span>
      <Input type={type} value={value[key]} disabled={disabled} autoComplete="off" onChange={event => onChange({ ...value, [key]: event.target.value })}/>
    </label>;
  return <>
    <p className="text-xs text-muted-foreground">Find both in Qonto under Integrations and Partnerships, API key. The space then holds your transactions, receipts, invoices and statements, and keeps them in sync.</p>
    {field('login', 'Login')}{field('secretKey', 'Secret key', 'password')}
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
  if (binding && binding.status !== 'active') return { failed: true, text: `The ${sourceLabel(source.provider)} login needs attention (${binding.status}). Connect again with current details.` };
  if (!report) return { failed: false, text: binding?.lastSyncedAt ? `Last synced ${when(binding.lastSyncedAt)}.` : 'The first sync is under way. Folders and documents appear here as it lands them.' };
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
  const [form, setForm] = useState<SourceLogin | QontoLogin | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [synced, setSynced] = useState<{ failed: boolean; text: string } | null>(null), [syncing, setSyncing] = useState(false);
  const alive = useRef(true);
  /** A login being typed: only Connect sends it, so nothing around this form may discard it unasked. */
  const formStart = useRef<SourceLogin | QontoLogin | null>(null);
  const openForm = (start: SourceLogin | QontoLogin) => { formStart.current = start; setForm(start); };
  const drafting = !!form && JSON.stringify(form) !== JSON.stringify(formStart.current);
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
  // Connecting starts the first sync in the background: follow it here until it has finished once.
  const firstSync = !!source && !binding?.lastSyncedAt && !binding?.lastError;
  useEffect(() => {
    if (!firstSync) return;
    const timer = setInterval(() => void load(), FIRST_SYNC_POLL_MS);
    return () => clearInterval(timer);
  }, [firstSync]);
  const syncNow = async () => {
    setSyncing(true); setError(null); setSynced(null);
    try { const outcome = await syncSource(); if (alive.current) { setSynced(syncOutcomeNote(outcome, sourceLabel(source?.provider))); await load(); onChanged(); } }
    catch (e) { if (alive.current) setError(message(e)); }
    finally { if (alive.current) setSyncing(false); }
  };
  const locked = disabled || busy || syncing;
  const formReady = !!form && (isQontoLogin(form) ? qontoLoginReady(form) : loginReady(form));
  const connect = () => { if (form && !locked && formReady) void run(() => connectSource(isQontoLogin(form) ? form : loginPayload(form))); };
  const qonto = source?.provider === 'canopy.qonto';
  const alert = error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null;
  return <section aria-labelledby="settings-source" className="space-y-2"><h3 id="settings-source" className="text-xs font-medium text-muted-foreground">Source</h3>
    {form ? null : alert}
    {!status ? <p role="status" className="text-sm text-muted-foreground">Loading source…</p> : source ? (
      <div className="space-y-2 rounded-lg border px-3 py-2.5">
        <div className="flex items-start gap-3"><Icon name="link" size={18} className="mt-0.5 text-muted-foreground"/>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{sourceLabel(source.provider)} · {source.account}</p>
            <p className="truncate text-xs text-muted-foreground">{qonto ? 'Mirrors this Qonto account. Nothing here goes back to Qonto.' : <>Mirrors {source.folder ? `the folder ${source.folder}` : 'every folder'}. {source.canUpload ? 'Uploads go on to a3doc.' : 'This a3doc user can only read, so nothing can be uploaded here.'}</>}</p>
            <p className="text-xs text-muted-foreground">{binding?.lastSyncedAt ? `Last synced ${when(binding.lastSyncedAt)}.` : 'First sync under way.'}</p>
            {note && (note.failed || report) ? <p className={`text-xs ${note.failed ? 'text-destructive' : 'text-muted-foreground'}`}>{note.text}</p> : null}
            {synced ? <p role="status" className={`text-xs ${synced.failed ? 'text-destructive' : 'text-muted-foreground'}`}>{synced.text}</p> : null}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">Folders and documents here follow {sourceLabel(source.provider)}, so they can't be renamed, moved or deleted in Canopy. Disconnecting keeps every file, and the space becomes an ordinary one.</p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => void syncNow()}>{syncing ? 'Syncing…' : 'Sync now'}</Button>
          <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => openForm(qonto ? { ...emptyQontoLogin, login: source.account } : { ...empty, companyCode: source.account, folder: source.folder })}>Connect again</Button>
          <Button type="button" variant="ghost" size="sm" disabled={locked} onClick={() => void run(disconnectSource)}>{busy && !form ? 'Disconnecting…' : 'Disconnect'}</Button>
        </div>
      </div>
    ) : (
      <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5"><Icon name="cloud" size={18} className="text-muted-foreground"/>
        <div className="flex-1"><p className="text-sm font-medium">Canopy storage</p><p className="text-xs text-muted-foreground">Files stay in this install’s storage.</p></div>
        {!form ? <div className="flex gap-2"><Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => openForm(empty)}>Connect a3doc</Button><Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => openForm(emptyQontoLogin)}>Connect Qonto</Button></div> : null}
      </div>
    )}
    {/* These fields sit inside the settings form, where Enter would save the space and not the login. */}
    {form ? <div role="group" aria-label={isQontoLogin(form) ? 'Connect Qonto' : 'Connect a3doc'} className="space-y-2 rounded-lg border px-3 py-2.5"
      onKeyDown={event => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); connect(); } }}>
      {isQontoLogin(form) ? <QontoLoginFields value={form} disabled={locked} onChange={setForm}/> : <SourceLoginFields value={form} disabled={locked} onChange={setForm}/>}
      {alert}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setForm(null); setError(null); }}>Cancel</Button>
        <Button type="button" size="sm" disabled={locked || !formReady}
          onClick={connect}>{busy ? 'Connecting…' : 'Connect'}</Button>
      </div>
    </div> : null}
  </section>;
}
