import { currentSite } from './api';

const POLL_MS = 60_000;
const COALESCE_MS = 150;
const MAX_RETRY_MS = 60_000;

/** The selected site cannot ride a WebSocket header, so use the same checked
 * `?site=` address that download links use. The worker still resolves the scope
 * inside the routed tenant and checks every frame against drive:read. */
export function liveUrl(): string {
  const url = new URL('/api/live', window.location.href);
  const site = currentSite();
  if (site) url.searchParams.set('site', site);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/** Push is only a nudge. A bounded poll catches frames lost during disconnect,
 * permission changes that cannot be announced to the now-unentitled subscriber,
 * and hosts or network paths that cannot carry WebSockets. */
export function watchDriveChanges(onChange: () => void): () => void {
  let active = true;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let coalesced: ReturnType<typeof setTimeout> | null = null;
  let retryMs = 1_000;

  const changed = () => {
    if (!active || document.visibilityState === 'hidden') return;
    if (coalesced) clearTimeout(coalesced);
    coalesced = setTimeout(() => {
      coalesced = null;
      if (active) onChange();
    }, COALESCE_MS);
  };
  const retryLater = () => {
    if (!active || retry) return;
    retry = setTimeout(() => {
      retry = null;
      connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
  };
  const connect = () => {
    if (!active || typeof WebSocket === 'undefined') return;
    try {
      socket = new WebSocket(liveUrl());
      socket.onopen = () => { retryMs = 1_000; };
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as { kind?: string; entityType?: string };
          if (frame.kind === 'change' && (frame.entityType === 'file' || frame.entityType === 'folder')) changed();
        } catch { /* An unknown frame is not a reason to refresh the drive. */ }
      };
      socket.onclose = retryLater;
    } catch {
      retryLater();
    }
  };

  const poll = setInterval(changed, POLL_MS);
  const visible = () => { if (document.visibilityState === 'visible') changed(); };
  document.addEventListener('visibilitychange', visible);
  connect();

  return () => {
    active = false;
    clearInterval(poll);
    if (retry) clearTimeout(retry);
    if (coalesced) clearTimeout(coalesced);
    document.removeEventListener('visibilitychange', visible);
    socket?.close();
  };
}
