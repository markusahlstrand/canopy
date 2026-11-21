import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon, cn } from '@canopy/ui';
import { refreshSourceFolder, type FolderRefresh } from './api';

/**
 * How long the page keeps asking while a check shows "Checking…", when the server names no window
 * of its own (it sends `recheckWindowMs`, derived from how long it keeps a request under way).
 */
export const DEFAULT_RECHECK_WINDOW_MS = 4 * 60_000 + 5_000;
/** How soon a recheck that could not reach the worker is tried again, while the window lasts. */
const RETRY_FAILED_MS = 5_000;
/** A check this recent that landed changes is this ask's own, so the listing is read again. */
const JUST_CHECKED_MS = 15_000;
/** How often the "Checked 2 min ago" wording moves on. */
const TICK_MS = 30_000;

/** `Checked just now`, `Checked 4 min ago`, `Checked at 09:46`, or for another day, the date too. */
export function checkedAgo(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return new Date(now).toDateString() === date.toDateString() ? `at ${time}` : `on ${date.toLocaleDateString()} at ${time}`;
}

/** What the line says, for the folder's state. `label` names the source ("a3doc"). */
export function freshnessText(refresh: FolderRefresh | null, label: string, now = Date.now()): string | null {
  if (!refresh) return null;
  switch (refresh.state) {
    case 'checking': return `Checking ${label} for changes…`;
    case 'checked': return `Checked ${checkedAgo(refresh.checkedAt!, now)}.`;
    case 'failed': return `Couldn't check ${label}${refresh.checkedAt ? ` (${checkedAgo(refresh.checkedAt, now)})` : ''}: ${refresh.error ?? 'no reason given'}. Showing what's already here.`;
    case 'unchecked': return `Not checked against ${label} yet.`;
  }
}

/**
 * Check the open folder of a connected space against its source: once when it opens, again on
 * demand (`check(true)`), and every few seconds while the server says a check is under way. The
 * listing never waits for any of it; `onChecked` runs when a check ends, so the page re-reads the
 * folder quietly (a live frame usually got there first). Failures are kept as the folder's state;
 * a request that cannot reach the worker at all leaves the line as it was.
 */
export function useFolderFreshness(folderId: string, enabled: boolean, onChecked: () => void) {
  const [refresh, setRefresh] = useState<FolderRefresh | null>(null);
  const latest = useRef<FolderRefresh | null>(null);
  const [asking, setAsking] = useState(false);
  /** A check the page stopped waiting for: still "checking" on the server, but not spinning here. */
  const [stalled, setStalled] = useState(false);
  /** When the current run of "Checking…" answers began, so the page knows when to stop asking. */
  const since = useRef<number | null>(null);
  /** The window the server named for the current run of "Checking…". */
  const windowMs = useRef(DEFAULT_RECHECK_WINDOW_MS);
  const generation = useRef(0);
  /** Which ask is the latest: an answer to any earlier one is superseded and dropped. */
  const latestAsk = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checked = useRef(onChecked);
  checked.current = onChecked;

  const ask = useCallback(async (force: boolean, gen: number) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (force) since.current = null;
    const mine = ++latestAsk.current;
    const current = () => gen === generation.current && mine === latestAsk.current;
    /** Ask again after `delay` while the window lasts; past it, stop spinning and let the person ask. */
    const again = (delay: number) => {
      if (since.current !== null && Date.now() + delay <= since.current + windowMs.current) timer.current = setTimeout(() => void ask(false, gen), delay);
      else setStalled(true);
    };
    setStalled(false);
    setAsking(true);
    try {
      const answer = await refreshSourceFolder(folderId, force);
      if (!current()) return;
      const previous = latest.current;
      latest.current = answer.refresh;
      setRefresh(answer.refresh);
      // A check that was running has ended (or one ran now): the folder may have changed under the listing.
      const ended = answer.refresh && answer.refresh.state !== 'checking';
      const justLanded = ended && answer.refresh!.changes > 0 && !!answer.refresh!.checkedAt && Date.now() - Date.parse(answer.refresh!.checkedAt) < JUST_CHECKED_MS;
      if (ended && (previous?.state === 'checking' || justLanded)) checked.current();
      if (answer.refresh?.state === 'checking' && answer.retryAfterMs) {
        since.current ??= Date.now();
        windowMs.current = answer.recheckWindowMs ?? DEFAULT_RECHECK_WINDOW_MS;
        // Past the window the server would have answered or started over: stop spinning, and let
        // the person ask again rather than show "Checking…" with a disabled button for good.
        again(answer.retryAfterMs);
      } else {
        since.current = null;
      }
    } catch {
      // Offline, or a worker without the route. With nothing shown, say nothing. While the line
      // says "Checking…", a failed recheck is tried again within the window, and past it the
      // line stops spinning, so it never sits there with Check now disabled.
      if (current() && latest.current?.state === 'checking') again(RETRY_FAILED_MS);
    } finally {
      if (current()) setAsking(false);
    }
  }, [folderId]);

  useEffect(() => {
    const gen = ++generation.current;
    latest.current = null;
    since.current = null;
    windowMs.current = DEFAULT_RECHECK_WINDOW_MS;
    setRefresh(null);
    setStalled(false);
    if (enabled) void ask(false, gen);
    return () => { generation.current++; if (timer.current) clearTimeout(timer.current); };
  }, [folderId, enabled, ask]);

  const check = useCallback(() => void ask(true, generation.current), [ask]);
  return { refresh, asking, stalled, check };
}

/** The folder's line: when it was last checked against its source, and a button to check it now. */
export function FolderFreshness({ refresh, asking, stalled = false, label, disabled, onCheck }: {
  refresh: FolderRefresh | null; asking: boolean; stalled?: boolean; label: string; disabled?: boolean; onCheck: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setNow(Date.now()), [refresh]);
  const waitedOut = stalled && refresh?.state === 'checking';
  const checking = (refresh?.state === 'checking' && !waitedOut) || (asking && !refresh);
  const text = waitedOut
    ? `No answer from ${label} yet. Check now to ask again.`
    : freshnessText(refresh, label, now) ?? (checking ? `Checking ${label} for changes…` : null);
  if (!text) return null;
  const failed = refresh?.state === 'failed';
  return <div role="status" aria-live="polite" className="-mt-2 mb-3 flex items-center gap-2 text-xs text-muted-foreground" data-testid="folder-freshness">
    <span className={cn('min-w-0 truncate', failed && 'text-amber-700 dark:text-amber-400')} title={text}>{text}</span>
    <button type="button" className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 hover:bg-muted hover:text-foreground disabled:opacity-50"
      disabled={disabled || checking || asking} onClick={onCheck} aria-label={`Check this folder in ${label} now`} title={`Check this folder in ${label} now`}>
      <Icon name="refresh" size={13} className={cn(checking && 'animate-spin')} />
      <span className="hidden sm:inline">Check now</span>
    </button>
  </div>;
}
