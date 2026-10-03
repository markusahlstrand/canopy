import { useEffect, useRef, useState } from 'react';
import { Button } from '@canopy/ui';
/** Copies only already-displayed text during the user gesture; no network reads. */
export function CopyPreviewText({ text }: { text: string }) {
  const current = useRef(text); current.current = text;
  const sequence = useRef(0), mounted = useRef(true);
  const [state, setState] = useState<{ text: string; busy: boolean; message: string }>({ text, busy: false, message: '' });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);
  const busy = state.text === text && state.busy;
  const copy = async () => {
    if (busy) return;
    const ticket = ++sequence.current, value = text;
    setState({ text: value, busy: true, message: '' });
    let message = 'Displayed text copied.';
    try { await navigator.clipboard.writeText(value); }
    catch { message = 'Could not copy. Select the displayed text below and copy it manually.'; }
    if (mounted.current && ticket === sequence.current && current.current === value) setState({ text: value, busy: false, message });
  };
  return <span className="inline-flex flex-wrap items-center gap-2">
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void copy()}>{busy ? 'Copying…' : 'Copy displayed text'}</Button>
    {state.text === text && state.message ? <span role="status" aria-label="Copy text status" className="text-xs text-muted-foreground">{state.message}</span> : null}
  </span>;
}
