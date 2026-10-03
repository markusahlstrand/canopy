import { useEffect, useRef, useState } from 'react';
import { Button } from '@canopy/ui';
/** Copies only already-displayed text during the user gesture; no network reads. */
export function CopyPreviewText({ text, truncated = false }: { text: string; truncated?: boolean }) {
  const current = useRef(text); current.current = text;
  const sequence = useRef(0), mounted = useRef(true);
  const [state, setState] = useState<{ text: string; busy: boolean; message: string }>({ text, busy: false, message: '' });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);
  const busy = state.text === text && state.busy;
  const copy = async () => {
    if (busy) return;
    const ticket = ++sequence.current, value = text;
    setState({ text: value, busy: true, message: '' });
    let message = truncated ? `Copied the first ${value.length.toLocaleString()} characters (UTF-16 units). The file is longer; download it for the rest.` : 'Displayed text copied.';
    try { await navigator.clipboard.writeText(value); }
    catch { message = 'Could not copy. Select the displayed text below and copy it manually.'; }
    if (mounted.current && ticket === sequence.current && current.current === value) setState({ text: value, busy: false, message });
  };
  return <span className="inline-flex flex-wrap items-center gap-2">
    <Button size="sm" variant="outline" aria-disabled={busy} onClick={() => void copy()}>{busy ? 'Copying…' : truncated ? 'Copy loaded text' : 'Copy displayed text'}</Button>
    <span role="status" className="text-xs text-muted-foreground">{state.text === text ? state.message : ''}</span>
  </span>;
}
