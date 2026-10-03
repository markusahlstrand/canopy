import { useMemo, useState } from 'react';
import { Button } from '@canopy/ui';
import { TextPreview } from './text-preview';

/** Validate JSON, then change only whitespace outside strings; never serialize parsed values. */
export function formatJson(text: string): string {
  if (text.length > 512 * 1024) throw new Error('JSON is too large to format.');
  JSON.parse(text);
  let result = '', depth = 0, quoted = false, escaped = false;
  const newline = () => { result += '\n' + '  '.repeat(depth); };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) { result += char; if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') { quoted = true; result += char; }
    else if (char === '{' || char === '[') {
      if (++depth > 100) throw new Error('JSON nesting is too deep to format.');
      result += char; let next = i + 1; while (/\s/.test(text[next] ?? '') && next < text.length) next++;
      if (text[next] !== '}' && text[next] !== ']') newline();
    } else if (char === '}' || char === ']') {
      depth--; let previous = i - 1; while (previous >= 0 && /\s/.test(text[previous]!)) previous--;
      if (text[previous] !== '{' && text[previous] !== '[') newline(); result += char;
    } else if (char === ',') { result += char; newline(); }
    else if (char === ':') result += ': ';
    else if (!/\s/.test(char)) result += char;
    if (result.length > 1024 * 1024) throw new Error('Formatted JSON would be too large.');
  }
  return result;
}
export function JsonPreview({ text, wrap, onWrapChange }: { text: string; wrap: boolean; onWrapChange: (wrap: boolean) => void }) {
  const [formatted, setFormatted] = useState(false);
  const result = useMemo(() => { if (!formatted) return null; try { return { text: formatJson(text) }; } catch { return { error: 'Could not format this JSON. It may be invalid or exceed preview limits.' }; } }, [text, formatted]);
  return <div className="space-y-2"><Button size="sm" variant="outline" aria-pressed={formatted} onClick={() => setFormatted(value => !value)}>Format JSON</Button>
    {result?.error ? <p role="alert">{result.error}</p> : formatted ? <p className="text-xs text-muted-foreground">Formatted for reading. Editing and downloads use the original text.</p> : null}
    <TextPreview key={formatted ? 'formatted' : 'original'} text={result?.text ?? text} wrap={wrap} onWrapChange={onWrapChange} />
  </div>;
}
