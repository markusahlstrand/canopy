import { useState } from 'react';
import { Button } from '@canopy/ui';

/** Display plain text either wrapped to the preview pane or with its original line layout. */
export function TextPreview({ text }: { text: string }) {
  const [wrap, setWrap] = useState(true);
  return <div className="min-w-0 space-y-2">
    <Button size="sm" variant="outline" aria-pressed={wrap} onClick={() => setWrap(value => !value)}>Wrap lines</Button>
    <pre className={wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere] text-xs' : 'overflow-x-auto whitespace-pre text-xs'}>{text}</pre>
  </div>;
}
