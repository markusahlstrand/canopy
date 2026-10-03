import { useEffect, useRef, useState } from 'react';
import { Button } from '@canopy/ui';
import { fileBodyAsText, TextEncodingError, versionContentUrl } from './api';
import { normalizeComparisonText } from './line-diff';
import { LineDiffView } from './line-diff-view';
import { latestOnly } from './reads';

/** Both reads use immutable version ids; comparison is a bounded, read-only preview. */
export function VersionComparison({ fileId, selectedId, currentId, onClose }: {
  fileId: string; selectedId: string; currentId: string; onClose: () => void;
}) {
  const [result, setResult] = useState<{ selected: string; current: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null);
  const [retry, setRetry] = useState(0);
  const guard = useRef(latestOnly()).current;
  useEffect(() => {
    const ticket = guard.take(); setResult(null); setError(null);
    void Promise.all([fileBodyAsText(fileId, selectedId), fileBodyAsText(fileId, currentId)]).then(([selected, current]) => {
      if (guard.current(ticket)) setResult({ selected: selected.text, current: current.text, truncated: selected.truncated || current.truncated });
    }).catch((error: unknown) => {
      if (guard.current(ticket)) setError({ message: error instanceof Error ? error.message || 'Could not compare versions.' : String(error), retryable: !(error instanceof TextEncodingError) });
    });
    return () => guard.invalidate();
  }, [fileId, selectedId, currentId, retry, guard]);
  return <section aria-label="Version comparison" className="space-y-2 rounded border border-border p-3">
    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">Compare text versions</h3>
      <Button size="sm" variant="ghost" onClick={onClose}>Close comparison</Button></div>
    {error ? <><p role="alert" className="text-sm">{error.message}</p>{error.retryable ? <Button size="sm" variant="outline" onClick={() => setRetry(value => value + 1)}>Retry comparison</Button> : null}<a className="text-sm underline" href={versionContentUrl(fileId, selectedId)} download>Download selected version</a>{' · '}<a className="text-sm underline" href={versionContentUrl(fileId, currentId)} download>Download current version</a></> : !result ? <p role="status">Loading comparison…</p> : <>
      <p role="status" className="text-xs text-muted-foreground">{result.truncated ? 'Showing partial text. Download both versions to compare the full files.' : normalizeComparisonText(result.selected) === normalizeComparisonText(result.current) ? 'These versions contain the same text (ignoring line endings and a final newline).' : 'These versions contain different text.'}</p>
      {normalizeComparisonText(result.selected) !== normalizeComparisonText(result.current) ? <LineDiffView before={result.selected} after={result.current} /> : null}
      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        <div className="min-w-0"><h4 className="text-xs font-medium">Selected version</h4><pre className="max-h-80 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] text-xs">{result.selected}</pre></div>
        <div className="min-w-0"><h4 className="text-xs font-medium">Current at open</h4><pre className="max-h-80 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] text-xs">{result.current}</pre></div>
      </div>
    </>}
  </section>;
}
