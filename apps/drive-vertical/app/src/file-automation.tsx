import { useEffect, useState } from 'react';
import { Button } from '@canopy/ui';
import { getSpaceSettings, retrySourceSend, setFileCategory, type FileDetails } from './api';
import type { SpaceCategory } from '../../src/space-settings';

/**
 * What automation knows about a file, above its description: its category (Document AI's
 * choice, or a person's), a send to a3doc that failed and can be retried, and whether a flow
 * copied it here.
 */
export function FileAutomation({ details, onChanged }: { details: FileDetails; onChanged: () => void }) {
  // Loaded only when someone opens the picker: most views never need the list, and only the
  // space's owners may read its settings.
  const [categories, setCategories] = useState<SpaceCategory[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setPicking(false); setError(null); }, [details.fileId]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await work(); onChanged(); } catch (e) { setError(e instanceof Error ? e.message || 'That did not work.' : String(e)); } finally { setBusy(false); }
  };
  const pick = async () => {
    setPicking(true);
    if (categories) return;
    try { setCategories((await getSpaceSettings()).categories ?? []); }
    catch { setCategories([]); setError('Only an owner of this space can see its categories.'); }
  };

  const category = details.category ?? null;
  const nameOf = (id: string) => categories?.find((c) => c.id === id)?.name ?? prettyId(id);

  return (
    <div className="space-y-2">
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      {details.send?.state === 'failed' ? (
        <div role="alert" className="space-y-1 rounded border border-destructive/40 p-2">
          <p className="font-medium">Not sent to a3doc</p>
          <p className="text-xs text-muted-foreground">{details.send.error ?? 'The last try failed.'}{details.send.attempts > 1 ? ` (${details.send.attempts} tries)` : ''}</p>
          {details.canWrite ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void act(() => retrySourceSend(details.fileId))}>{busy ? 'Sending…' : 'Retry'}</Button> : null}
        </div>
      ) : details.send?.state === 'sending' ? <p role="status" className="text-xs text-muted-foreground">Sending to a3doc…</p> : null}
      {details.origin ? <p className="text-xs text-muted-foreground">Copied here by a flow.</p> : null}
      {category?.id || details.canWrite ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span>Category: <span className="font-medium">{category?.id ? nameOf(category.id) : 'None'}</span></span>
            {details.canWrite && !picking ? <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void pick()}>Change</Button> : null}
          </div>
          {category?.id ? (
            <span className="block text-xs text-muted-foreground">
              {category.source === 'person' ? 'Chosen by a person; Document AI leaves it.' : `Chosen by Document AI${category.confidence !== null ? `, ${Math.round(category.confidence * 100)}% sure` : ''}.`}
            </span>
          ) : null}
          {picking && categories?.length ? (
            <select aria-label="Category" className="w-full rounded border border-border bg-background p-2" disabled={busy}
              value={category?.id ?? ''} onChange={(event) => void act(async () => { await setFileCategory(details.fileId, event.target.value || null); setPicking(false); })}>
              <option value="">{category?.id ? 'None (let Document AI choose)' : 'None'}</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              {category?.id && !categories.some((c) => c.id === category.id) ? <option value={category.id}>{prettyId(category.id)}</option> : null}
            </select>
          ) : picking && categories && !error ? <p className="text-xs text-muted-foreground">This space has no categories yet. Add them in Space settings, under Document AI.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/** `bank-statement` → `Bank statement`: how an id reads before the list is loaded. */
const prettyId = (id: string) => (id.charAt(0).toUpperCase() + id.slice(1)).replace(/-/g, ' ');
