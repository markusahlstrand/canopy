import type { AiMessage, PluginManifest } from "@canopy/core";

/** What the model is asked to produce: a manifest plus the viewer's ESM entry source. */
export interface GeneratedPlugin {
  manifest: PluginManifest;
  source: string;
}

/**
 * The plugin-authoring contract, condensed for a single-pass generation. This is
 * the same spec the `/new-plugin` Claude Code skill follows
 * (documentation/09-build-a-plugin-with-ai.md) — here it's the system prompt for
 * the core LLM so the portal can author a plugin without an external agent. We
 * only ever generate **sandboxed viewers**: the one kind that runs with no host
 * edits, and the only thing the studio can install + run on its own.
 */
const SYSTEM = `You write Canopy file-viewer plugins. A plugin is TWO things: a manifest (canopy.json) and an ESM entry module (index.js).

THE SANDBOX CONTRACT — the entry module runs inside <iframe sandbox="allow-scripts"> with NO allow-same-origin (an opaque origin). Hard constraints:
- It exports a default function render(ctx). ctx = { container: HTMLElement, file: { name, mime, bytes (ArrayBuffer), writable }, emit: (action, data?) => void }.
- NO access to the host page, window.parent, DOM outside container, cookies, localStorage, or same-origin requests. Inline styles only — no host CSS, no React.
- You MAY import() from a CDN (e.g. https://esm.sh/...) and fetch() public URLs, but ALWAYS wrap those in try/catch and degrade gracefully (a plain fallback or a short message) — the sandbox may block the network.
- Build the view from bytes: binary → URL.createObjectURL(new Blob([file.bytes], { type: file.mime })); text → new TextDecoder().decode(new Uint8Array(file.bytes)).
- render may be async. The host auto-resizes the frame to content height — don't manage outer layout.
- On success call ctx.emit("loaded", {...}); on failure render a short message into container.

THE MANIFEST — fields:
- id: kebab-case, unique, 2–49 chars (e.g. "gpx-viewer"). name: display name. version: "0.1.0".
- icon: a lucide icon name (e.g. "map", "table", "image"). color: HSL WITHOUT hsl(), e.g. "160 60% 45%".
- entry: "index.js".
- capabilities: declare ONLY what's used. A read-only viewer needs exactly [{ "kind": "item:read" }]. A viewer that calls an API adds { "kind": "net:fetch", "hosts": ["example.com"] } (hosts is required and non-empty). Do NOT request any other capability.
- contributes.viewers: an array of { id, title, match }. match is an array of exact MIMEs ("text/csv"), MIME wildcards ("image/*"), or dot-extensions (".csv"). Be specific; the host picks the FIRST viewer whose match covers the file.
- contributes.store: { category: one of "Productivity"|"Finance"|"Lifestyle"|"Security"|"Media"|"Wellness"|"Help", tagline: a short sentence }.

Build a READ-ONLY viewer unless the user explicitly asks to edit/save.

OUTPUT — respond with a SINGLE JSON object and nothing else (no markdown, no prose, no code fences):
{ "manifest": { ...the canopy.json object... }, "source": "the full index.js as a string" }
The "source" string must be valid ESM that exports a default render(ctx) function.

EXAMPLE (for a "render CSV as a table" request):
{ "manifest": { "id": "csv-viewer", "name": "CSV Viewer", "version": "0.1.0", "description": "Renders CSV files as a table.", "icon": "table", "color": "160 60% 45%", "entry": "index.js", "capabilities": [{ "kind": "item:read" }], "contributes": { "viewers": [{ "id": "csv", "title": "CSV", "match": ["text/csv", ".csv", ".tsv"] }], "store": { "category": "Productivity", "tagline": "View spreadsheets inline." } } }, "source": "export default function render(ctx){const{container,file}=ctx;const text=new TextDecoder().decode(new Uint8Array(file.bytes));const rows=text.trim().split(/\\r?\\n/).map(l=>l.split(','));const t=document.createElement('table');t.style.cssText='border-collapse:collapse;width:100%;font:13px system-ui,sans-serif';rows.forEach((cells,r)=>{const tr=document.createElement('tr');cells.forEach(c=>{const el=document.createElement(r===0?'th':'td');el.textContent=c;el.style.cssText='border:1px solid #d1d5db;padding:6px 10px;text-align:left'+(r===0?';font-weight:600':'');tr.appendChild(el)});t.appendChild(tr)});container.appendChild(t);ctx.emit('loaded',{rows:rows.length})}" }`;

/** System + user messages for one generation pass. */
export function buildGenerationMessages(idea: string): AiMessage[] {
  return [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `Build a Canopy file-viewer plugin: ${idea.trim()}\n\nReturn only the JSON object described above.`,
    },
  ];
}

/**
 * Tolerantly parse a model reply into a {manifest, source}. Strips ```fences``` and
 * locates the outermost JSON object, since not every provider honors strict-JSON
 * mode. Throws a readable error if it can't recover a usable shape.
 */
export function parseGeneratedPlugin(text: string): GeneratedPlugin {
  let raw = text.trim();
  // Strip a leading/trailing markdown code fence if the model added one.
  const fence = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) raw = fence[1]!.trim();
  // Fall back to the outermost { ... } if there's surrounding prose.
  if (!raw.startsWith("{")) {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) raw = raw.slice(first, last + 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("the model didn't return valid JSON — try again or pick a different model");
  }
  const obj = parsed as { manifest?: unknown; source?: unknown };
  if (!obj.manifest || typeof obj.manifest !== "object") throw new Error("response had no manifest");
  if (typeof obj.source !== "string" || !obj.source.trim()) throw new Error("response had no source");
  return { manifest: obj.manifest as PluginManifest, source: obj.source };
}
