import { useState } from 'react';
import { Button, Icon } from '@canopy/ui';

export type PluginKind = 'viewer' | 'app';

/** A prompt for external authoring that targets the running drive's single-file Studio contract. */
export function buildPluginPrompt(idea: string, kind: PluginKind): string {
  const goal = idea.trim() || (kind === 'viewer' ? 'Describe the file type and how to display it.' : 'Describe the app and what it should do.');
  const contribution = kind === 'viewer'
    ? 'contributes.viewers: [{"id":"main","title":"Viewer title","match":[".ext","application/example"]}] and an item:read capability.'
    : 'contributes.detailView: {"id":"main","title":"App title"}. A self-contained app needs no file capability.';
  return `Build a Canopy ${kind === 'viewer' ? 'file viewer' : 'standalone app'} plugin for this idea: ${goal}

Return exactly two fenced code blocks: one json block containing canopy.json, then one js block containing the entire JavaScript entry. The manifest must have a kebab-case id (2–49 characters), name, version, capabilities, and ${contribution}

The JavaScript must be one self-contained ES module with export default function render(ctx). It runs in an opaque-origin iframe. Use ctx.container and, for a viewer, ctx.file {name, mime, bytes, writable}. Do not access the host page, cookies, or storage. Do not use relative imports. If you load code from a public CDN, declare its hostname in a net:fetch capability and provide an offline fallback. For editing, request item:write and emit save with {content} only when ctx.file.writable is true.

After generating, explain which file type to use for testing. I will paste the manifest and JavaScript into Canopy's Plugin Studio, review the capabilities, and install it there.`;
}

export function PluginAiHandoff() {
  const [idea, setIdea] = useState('');
  const [kind, setKind] = useState<PluginKind>('viewer');
  const [message, setMessage] = useState('');
  const prompt = buildPluginPrompt(idea, kind);
  const copy = async () => {
    try { await navigator.clipboard.writeText(prompt); setMessage('Prompt copied.'); }
    catch { setMessage('Clipboard unavailable. Select and copy the prompt below.'); }
  };
  return <details className="rounded-lg border border-dashed p-3.5 text-sm">
    <summary className="cursor-pointer font-medium"><Icon name="sparkles" size={16} className="mr-2 inline" />Build with AI</summary>
    <p className="mt-3 text-muted-foreground">Describe a viewer or app, copy the prompt into a coding tool, then paste its manifest and JavaScript into Plugin Studio. Review the generated code before installing it.</p>
    <div className="mt-3 flex gap-2" role="group" aria-label="Plugin kind">
      {(['viewer', 'app'] as const).map(value => <Button key={value} type="button" size="sm" variant={kind === value ? 'default' : 'outline'} aria-pressed={kind === value} onClick={() => setKind(value)}>{value === 'viewer' ? 'File viewer' : 'App'}</Button>)}
    </div>
    <label className="mt-3 block">Describe your plugin<textarea aria-label="Plugin idea" value={idea} onChange={event => setIdea(event.target.value)} rows={3} placeholder="e.g. Show .gpx tracks on a map" className="mt-1 w-full resize-y rounded-md border bg-transparent p-2" /></label>
    <div className="mt-3 flex items-center justify-between"><span className="font-medium">Ready-to-paste prompt</span><Button type="button" size="sm" variant="outline" onClick={() => void copy()}>Copy prompt</Button></div>
    <textarea readOnly aria-label="AI plugin prompt" value={prompt} rows={10} className="mt-2 w-full resize-y rounded-md border bg-muted/40 p-2 font-mono text-xs" />
    {message ? <p role="status" className="mt-1 text-xs text-muted-foreground">{message}</p> : null}
  </details>;
}
