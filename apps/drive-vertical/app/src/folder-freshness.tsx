import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon, cn } from '@canopy/ui';
import { refreshSourceFolder, type FolderRefresh } from './api';

/** How many times a page asks again while a check stays "Checking…": about two and a half minutes. */
export const MAX_RECHECKS = 30;
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
    case 'unchecked': return null;
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
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checked = useRef(onChecked);
  checked.current = onChecked;

  const ask = useCallback(async (force: boolean, gen: number, attempt: number) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setAsking(true);
    try {
      const answer = await refreshSourceFolder(folderId, force);
      if (gen !== generation.current) return;
      const previous = latest.current;
      latest.current = answer.refresh;
      setRefresh(answer.refresh);
      // A check that was running has ended (or one ran now): the folder may have changed under the listing.
      const ended = answer.refresh && answer.refresh.state !== 'checking';
      const justLanded = ended && answer.refresh!.changes > 0 && !!answer.refresh!.checkedAt && Date.now() - Date.parse(answer.refresh!.checkedAt) < JUST_CHECKED_MS;
      if (ended && (previous?.state === 'checking' || justLanded)) checked.current();
      if (answer.refresh?.state === 'checking' && answer.retryAfterMs && attempt < MAX_RECHECKS) {
        timer.current = setTimeout(() => void ask(false, gen, attempt + 1), answer.retryAfterMs);
      }
    } catch {
      // Offline, or a worker without the route: say nothing rather than something wrong.
    } finally {
      if (gen === generation.current) setAsking(false);
    }
  }, [folderId]);

  useEffect(() => {
    const gen = ++generation.current;
    latest.current = null;
    setRefresh(null);
    if (enabled) void ask(false, gen, 0);
    return () => { generation.current++; if (timer.current) clearTimeout(timer.current); };
  }, [folderId, enabled, ask]);

  const check = useCallback(() => void ask(true, generation.current, 0), [ask]);
  return { refresh, asking, check };
}

/** The folder's line: when it was last checked against its source, and a button to check it now. */
export function FolderFreshness({ refresh, asking, label, disabled, onCheck }: {
  refresh: FolderRefresh | null; asking: boolean; label: string; disabled?: boolean; onCheck: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setNow(Date.now()), [refresh]);
  const checking = refresh?.state === 'checking' || (asking && !refresh);
  const text = freshnessText(refresh, label, now) ?? (checking ? `Checking ${label} for changes…` : null);
  if (!text) return null;
  const failed = refresh?.state === 'failed';
  return <div role="status" aria-live="polite" className="-mt-2 mb-3 flex items-center gap-2 text-xs text-muted-foreground" data-testid="folder-freshness">
    <span className={cn('min-w-0 truncate', failed && 'text-amber-700 dark:text-amber-400')} title={text}>{text}</span>
    <button type="button" className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 hover:bg-muted hover:text-foreground disabled:opacity-50"
      disabled={disabled || checking} onClick={onCheck} aria-label={`Check this folder in ${label} now`} title={`Check this folder in ${label} now`}>
      <Icon name="refresh" size={13} className={cn(checking && 'animate-spin')} />
      <span className="hidden sm:inline">Check now</span>
    </button>
  </div>;
}
