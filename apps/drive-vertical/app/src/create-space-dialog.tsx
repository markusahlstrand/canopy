import { SpaceStyleFields } from './space-style-fields';
import type { SpaceSettings } from '../../src/space-settings';
import { useEffect, useRef, useState } from 'react';
import { Button, Input, Icon, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@canopy/ui';
import { connectSource, requestSpace, spaceRequests, type QontoLogin, type SourceLogin, type SpaceRequest } from './api';
import { emptyLogin, emptyQontoLogin, isQontoLogin, loginPayload, loginReady, QontoLoginFields, qontoLoginReady, SourceLoginFields } from './source-settings';
/**
 * The platform owns provisioning; the dialog follows its durable result instead of claiming success on enqueue.
 * A space can start on an a3doc folder: the login waits in memory until the space exists, since a
 * connection binds to a space, and then goes to the same connect route space settings use. A
 * refused login leaves an ordinary space behind, so the dialog stays on it until the person retries
 * or moves on, and everything it reports sits outside the scrolling form, where it cannot be missed.
 */
export function CreateSpaceDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (slug: string) => void }) {
  const [icon, setIcon] = useState<SpaceSettings['icon']>('folder'), [color, setColor] = useState<SpaceSettings['color']>('#3b82f6');
  const [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<SpaceRequest | null>(null);
  const [statusMissing, setStatusMissing] = useState(false);
  const [checking, setChecking] = useState(true);
  const [checkFailed, setCheckFailed] = useState(false), [checkRetry, setCheckRetry] = useState(0);
  const [ignoredRequestId, setIgnoredRequestId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const [storage, setStorage] = useState<'canopy' | 'a3doc' | 'qonto'>('canopy'), [login, setLogin] = useState<SourceLogin>(emptyLogin), [qontoLogin, setQontoLogin] = useState<QontoLogin>(emptyQontoLogin);
  const sourceName = storage === 'qonto' ? 'Qonto' : 'a3doc';
  const held = storage === 'qonto' ? qontoLogin : login;
  const heldReady = storage === 'qonto' ? qontoLoginReady(qontoLogin) : loginReady(login);
  const [connecting, setConnecting] = useState(false), [connectFailed, setConnectFailed] = useState<{ slug: string; message: string } | null>(null);
  const active = useRef(true), slug = useRef('');
  /** The login for the request in flight; taken once, when that request is done. Never persisted. */
  const pendingLogin = useRef<{ requestId: string; login: SourceLogin | QontoLogin } | null>(null);
  /** The request already finished here: overlapping polls can each report it done before the effect stops. */
  const finished = useRef<string | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const connect = async (space: string, value: SourceLogin | QontoLogin) => {
    setConnecting(true);
    try { await connectSource(isQontoLogin(value) ? value : loginPayload(value), space); if (active.current) onCreated(space); }
    catch (error) { if (active.current) setConnectFailed({ slug: space, message: error instanceof Error ? error.message || `Could not reach ${isQontoLogin(value) ? 'Qonto' : 'a3doc'}.` : String(error) }); }
    finally { if (active.current) setConnecting(false); }
  };
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setChecking(true); setCheckFailed(false);
    spaceRequests().then(({requests}) => {
      if (!alive) return;
      setError(null);
      const pending = requests.filter(value => value.status === 'pending' && value.id !== ignoredRequestId)
        .sort((a,b) => (b.requestedAt ?? '').localeCompare(a.requestedAt ?? ''))[0];
      if (pending) {
        setRequest(current => current ?? pending);
        setName(current => current || pending.name);
      }
    }).catch(error => {
      if (alive) { setCheckFailed(true); setError(error instanceof Error ? error.message || 'Could not check previous space requests.' : String(error)); }
    }).finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; };
  }, [open, checkRetry]);
  useEffect(() => {
    if (!open || !request || request.status !== 'pending') return;
    let alive = true;
    setStatusMissing(false);
    const finish = async (done: SpaceRequest) => {
      if (finished.current === done.id) return;
      finished.current = done.id;
      const waiting = pendingLogin.current?.requestId === done.id ? pendingLogin.current.login : null;
      pendingLogin.current = null;
      if (!waiting) { onCreated(done.slug); return; }
      await connect(done.slug, waiting);
    };
    const check = async () => {
      try {
        const result = (await spaceRequests()).requests.find(value => value.id === request.id);
        if (!alive) return;
        if (!result) { setStatusMissing(true); return; }
        setStatusMissing(false);
        setRequest(result); setError(null);
        if (result.status !== 'pending') slug.current = '';
        if (result.status === 'done') void finish(result);
      } catch (error) { if (alive) setError(error instanceof Error ? error.message || 'Could not complete the request.' : String(error)); }
    };
    const interval = setInterval(() => void check(), 3000); void check();
    return () => { alive = false; clearInterval(interval); };
  }, [open, request?.id, request?.status, onCreated]);
  useEffect(() => {
    if (!open || request?.status !== 'pending' || !request.requestedAt) return;
    const deadline = Date.parse(request.requestedAt) + 5 * 60_000;
    const remaining = deadline - Date.now();
    if (remaining <= 0) { setNow(Date.now()); return; }
    // A timer can fire on the millisecond before Date.now reaches the deadline.
    const timer = setTimeout(() => setNow(current => Math.max(current, Date.now(), deadline)), remaining);
    return () => clearTimeout(timer);
  }, [open, request?.id, request?.requestedAt, request?.status]);
  const create = async () => {
    if (busy || checking || checkFailed || !name.trim() || request?.status === 'pending' || (storage !== 'canopy' && !heldReady)) return;
    setBusy(true); setError(null); setStatusMissing(false);
    // Keep the slug stable across an uncertain response so retry does not create two spaces.
    slug.current ||= `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 45) || 'space'}-${crypto.randomUUID().slice(0, 8)}`;
    try { const result = await requestSpace(name.trim(), slug.current, {name:name.trim(),icon,color}); if (active.current) {
      pendingLogin.current = storage !== 'canopy' ? { requestId: result.id, login: held } : null;
      setRequest({ ...result, status: 'pending', error: null, requestedAt: new Date().toISOString() });
    } }
    catch (error) { if (active.current) setError(error instanceof Error ? error.message || 'Could not complete the request.' : String(error)); }
    finally { if (active.current) setBusy(false); }
  };
  const retryConnect = () => { if (connectFailed && !connecting && heldReady) void connect(connectFailed.slug, held); };
  const loginLocked = busy || request?.status === 'pending' || connecting;
  const locked = loginLocked || connectFailed !== null;
  const choice = (value: 'canopy' | 'a3doc' | 'qonto', icon: 'cloud' | 'link', title: string, detail: string) =>
    <label className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 has-[:disabled]:cursor-default has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${storage === value ? 'border-primary bg-primary/5' : ''}`}>
      <input type="radio" name="space-storage" value={value} className="sr-only" checked={storage === value} disabled={locked} onChange={() => setStorage(value)}/>
      <Icon name={icon} size={18} className={storage === value ? 'text-primary' : 'text-muted-foreground'} />
      <div><p className="text-sm font-medium">{title}</p><p className="text-xs text-muted-foreground">{detail}</p></div>
    </label>;
  const stalled = request?.status === 'pending' && request.requestedAt && now - Date.parse(request.requestedAt) >= 5 * 60_000;
  // Polling stops with the dialog, and with it the only chance to use a held login.
  const holdingLogin = connecting || (request?.status === 'pending' && pendingLogin.current?.requestId === request.id && !stalled);
  return <Dialog open={open} onOpenChange={value => { if (!busy && !holdingLogin) onOpenChange(value); }}>
    <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[480px]">
      <DialogHeader className="px-5 pt-5">
        <DialogTitle>Create a space</DialogTitle>
        <DialogDescription>A shared place for a family, team, or project. You’ll be its owner.</DialogDescription>
      </DialogHeader>
      <form id="create-space" onSubmit={event => { event.preventDefault(); if (connectFailed) retryConnect(); else void create(); }} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
        <section className="space-y-2">
          <label htmlFor="space-name" className="text-xs font-medium text-muted-foreground">Space name</label>
          <Input id="space-name" autoFocus maxLength={100} placeholder="Space name (e.g. Family)" value={name}
            disabled={locked}
            onChange={event => { setName(event.target.value); slug.current = ''; if (request?.status !== 'pending') setRequest(null); }} />
          <SpaceStyleFields icon={icon} color={color} disabled={locked} onIcon={icon => setIcon(icon as SpaceSettings['icon'])} onColor={color => setColor(color as SpaceSettings['color'])} />
        </section>
        <section role="radiogroup" aria-labelledby="space-storage" className="space-y-2">
          <h3 id="space-storage" className="text-xs font-medium text-muted-foreground">Storage</h3>
          {choice('canopy', 'cloud', 'Canopy storage', 'Files stay in this install’s storage.')}
          {choice('a3doc', 'link', 'a3doc folder', 'The space mirrors a folder from your gestoría’s a3doc and keeps it in sync.')}
          {choice('qonto', 'link', 'Qonto account', 'The space holds your transactions, receipts, invoices and statements, and keeps them in sync.')}
          {storage === 'qonto' ? <div role="group" aria-label="Qonto login" className="space-y-2 rounded-lg border px-3 py-2.5">
            <QontoLoginFields value={qontoLogin} disabled={loginLocked} onChange={setQontoLogin}/>
          </div> : null}
          {storage === 'a3doc' ? <div role="group" aria-label="a3doc login" className="space-y-2 rounded-lg border px-3 py-2.5">
            <SourceLoginFields value={login} disabled={loginLocked} onChange={setLogin}/>
          </div> : null}
        </section>
        <section className="space-y-1 rounded-lg border border-dashed p-3">
          <h3 className="text-sm font-medium">People and plugins</h3>
          <p className="text-xs text-muted-foreground">After the space opens, invite members and choose plugins for everyone in its space settings.</p>
        </section>
      </form>
      <div className="shrink-0 space-y-2 border-t px-5 py-3 empty:hidden">
        {checking ? <p role="status" className="text-sm text-muted-foreground">Checking previous space requests…</p> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error} Your creation request can still complete; check its status before starting another.</p> : null}
        {statusMissing ? <p role="status" className="text-sm text-muted-foreground">The latest status did not include this request. It may still complete; Canopy will keep checking.</p> : null}
        {checkFailed ? <Button type="button" variant="outline" onClick={() => setCheckRetry(value => value + 1)}>Retry status check</Button> : null}
        {request ? <p role={request.status === 'failed' ? 'alert' : 'status'} className="rounded-lg bg-muted px-3 py-2 text-sm">{request.status === 'pending' ? (pendingLogin.current?.requestId === request.id ? `Creating your space… ${sourceName} connects once it is ready, so keep this page open.` : 'Creating your space… You can close this dialog and return to check its progress.') : request.status === 'failed' ? `Could not create the space: ${request.error ?? 'The platform refused the request.'}` : connecting ? `Space created. Connecting ${sourceName}…` : 'Space created.'}</p> : null}
        {connectFailed && !connecting ? <div role="alert" className="space-y-2 text-sm"><p className="text-destructive">The space was created, but {sourceName} did not connect: {connectFailed.message}</p><p className="text-muted-foreground">It is an ordinary space for now. Correct the login and try again, or open the space and connect {sourceName} later from its space settings.</p><Button type="button" variant="outline" onClick={() => onCreated(connectFailed.slug)}>Open the space</Button></div> : null}
        {stalled ? <div className="space-y-2 text-sm"><p>This request is still waiting. It may finish later, even if you start a different space.{pendingLogin.current?.requestId === request.id ? ` ${sourceName} only connects while this dialog is open; otherwise connect it later from the space’s settings.` : ''}</p><Button type="button" variant="outline" onClick={() => { setIgnoredRequestId(request.id); setRequest(null); setName(''); slug.current = ''; setError(null); setStatusMissing(false); }}>Start a different space</Button></div> : null}
      </div>
      <DialogFooter className="border-t px-5 py-3">
        <Button type="button" variant="ghost" disabled={busy || holdingLogin} onClick={() => onOpenChange(false)}>Close</Button>
        <Button type="submit" form="create-space" disabled={connectFailed ? connecting || !heldReady : busy || checking || checkFailed || !name.trim() || locked || (storage !== 'canopy' && !heldReady)}>{connectFailed ? (connecting ? 'Connecting…' : 'Try again') : busy ? 'Requesting…' : request?.status === 'failed' ? 'Retry creation' : 'Create space'}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
