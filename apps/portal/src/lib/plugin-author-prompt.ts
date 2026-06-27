import type { AiMessage, PluginManifest } from "@canopy/core";

/** What the model is asked to produce: a manifest plus the plugin's ESM entry source. */
export interface GeneratedPlugin {
  manifest: PluginManifest;
  source: string;
}

/**
 * What the studio is building this pass:
 * - `viewer` — a file viewer, opened when a matching file is previewed.
 * - `app` — a standalone mini-app (game, tool, dashboard), launched from the sidebar.
 * Both run with no host edits and are the only kinds the studio can install on its own.
 */
export type PluginKind = "viewer" | "app";

/**
 * The plugin-authoring contract, condensed for a single-pass generation. This is
 * the same spec the `/new-plugin` Claude Code skill follows
 * (documentation/09-build-a-plugin-with-ai.md) — here it's the system prompt for
 * the core LLM so the portal can author a plugin without an external agent.
 */
const SYSTEM_VIEWER = `You write Canopy file-viewer plugins. A plugin is TWO things: a manifest (canopy.json) and an ESM entry module (index.js).

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

OUTPUT — respond with EXACTLY two fenced code blocks and nothing else (no prose before, between, or after them):
1. A \`\`\`json block holding the manifest — the canopy.json object itself, NOT wrapped in any outer key.
2. A \`\`\`js block holding the full index.js module, written as ordinary JavaScript that exports a default render(ctx) function.
Write the source as normal code in the \`\`\`js block — do NOT escape it, stringify it, or embed it in JSON. That's the whole point of using two blocks: you write real code, not a JSON-encoded string.

EXAMPLE (for a "render CSV as a table" request):
\`\`\`json
{ "id": "csv-viewer", "name": "CSV Viewer", "version": "0.1.0", "description": "Renders CSV files as a table.", "icon": "table", "color": "160 60% 45%", "entry": "index.js", "capabilities": [{ "kind": "item:read" }], "contributes": { "viewers": [{ "id": "csv", "title": "CSV", "match": ["text/csv", ".csv", ".tsv"] }], "store": { "category": "Productivity", "tagline": "View spreadsheets inline." } } }
\`\`\`
\`\`\`js
export default function render(ctx) {
  const { container, file } = ctx;
  const text = new TextDecoder().decode(new Uint8Array(file.bytes));
  const rows = text.trim().split(/\\r?\\n/).map((line) => line.split(","));
  const table = document.createElement("table");
  table.style.cssText = "border-collapse:collapse;width:100%;font:13px system-ui,sans-serif";
  rows.forEach((cells, r) => {
    const tr = document.createElement("tr");
    cells.forEach((value) => {
      const cell = document.createElement(r === 0 ? "th" : "td");
      cell.textContent = value;
      cell.style.cssText = "border:1px solid #d1d5db;padding:6px 10px;text-align:left" + (r === 0 ? ";font-weight:600" : "");
      tr.appendChild(cell);
    });
    table.appendChild(tr);
  });
  container.appendChild(table);
  ctx.emit("loaded", { rows: rows.length });
}
\`\`\``;

const SYSTEM_APP = `You write Canopy *app* plugins — standalone mini-apps (games, tools, dashboards) that run on their own, NOT tied to any file. A plugin is TWO things: a manifest (canopy.json) and an ESM entry module (index.js).

THE SANDBOX CONTRACT — the entry module runs inside <iframe sandbox="allow-scripts"> with NO allow-same-origin (an opaque origin). Hard constraints:
- It exports a default function render(ctx). ctx = { container: HTMLElement, emit: (action, data?) => void }. There is NO file — the app builds its OWN UI inside container.
- NO access to the host page, window.parent, DOM outside container, cookies, localStorage, or same-origin requests. Inline styles only — no host CSS, no React.
- Build the entire UI inside container with createElement + inline styles, and wire up your own event listeners, timers, and state. For a game: render to a <canvas> or DOM nodes and capture input with listeners attached to the document or a focusable element inside container (the user clicks the app first).
- You MAY import() from a CDN (e.g. https://esm.sh/...) and fetch() public URLs, but ALWAYS wrap those in try/catch and degrade gracefully — the sandbox may block the network.
- The host mirrors its theme onto the frame, so style with hsl(var(--foreground)), hsl(var(--primary)), hsl(var(--card)), hsl(var(--border)), hsl(var(--muted-foreground)) to look native.
- render may be async. The host auto-resizes the frame to content height — give your root a definite height (a sized canvas, or a min-height) so it isn't clipped, and don't manage outer page layout.
- Call ctx.emit("loaded") once mounted.

THE MANIFEST — fields:
- id: kebab-case, unique, 2–49 chars. name: display name. version: "0.1.0".
- icon: a lucide icon name (e.g. "gamepad-2", "timer", "calculator"). color: HSL WITHOUT hsl(), e.g. "262 60% 55%".
- entry: "index.js".
- capabilities: declare ONLY what's used. A self-contained app needs [] (empty). One that calls an API adds { "kind": "net:fetch", "hosts": ["example.com"] } (hosts required, non-empty). Do NOT request item:read or any other capability unless it's actually used.
- contributes.detailView: { "id", "title", "nav": { "section": "<heading>" } }. nav.section is the sidebar HEADING the app is launched under — pick a short, sensible category for the idea (e.g. "Games", "Tools", "Fun"). This is what makes the app reachable.
- contributes.store: { category: one of "Productivity"|"Finance"|"Lifestyle"|"Security"|"Media"|"Wellness"|"Help", tagline: a short sentence }. (For a game, "Lifestyle" is fine.)

OUTPUT — respond with EXACTLY two fenced code blocks and nothing else (no prose before, between, or after them):
1. A \`\`\`json block holding the manifest — the canopy.json object itself, NOT wrapped in any outer key.
2. A \`\`\`js block holding the full index.js module, written as ordinary JavaScript that exports a default render(ctx) function.
Write the source as normal code in the \`\`\`js block — do NOT escape it, stringify it, or embed it in JSON.

EXAMPLE (for a "stopwatch" request):
\`\`\`json
{ "id": "stopwatch", "name": "Stopwatch", "version": "0.1.0", "description": "A simple start/stop/reset stopwatch.", "icon": "timer", "color": "212 92% 50%", "entry": "index.js", "capabilities": [], "contributes": { "detailView": { "id": "main", "title": "Stopwatch", "nav": { "section": "Tools" } }, "store": { "category": "Productivity", "tagline": "Time anything, right in the app." } } }
\`\`\`
\`\`\`js
export default function render(ctx) {
  const { container } = ctx;
  let elapsed = 0, timer = null;
  const wrap = document.createElement("div");
  wrap.style.cssText = "min-height:160px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;font:14px system-ui,sans-serif;color:hsl(var(--foreground))";
  const display = document.createElement("div");
  display.style.cssText = "font:600 44px ui-monospace,monospace;letter-spacing:1px";
  const fmt = (ms) => (ms / 1000).toFixed(1) + "s";
  display.textContent = fmt(0);
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px";
  const mkBtn = (label, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = "border:1px solid hsl(var(--border));background:hsl(var(--primary));color:hsl(var(--primary-foreground));border-radius:8px;padding:8px 16px;font:inherit;cursor:pointer";
    b.addEventListener("click", fn);
    return b;
  };
  const tick = () => { elapsed += 100; display.textContent = fmt(elapsed); };
  row.append(
    mkBtn("Start", () => { if (!timer) timer = setInterval(tick, 100); }),
    mkBtn("Stop", () => { clearInterval(timer); timer = null; }),
    mkBtn("Reset", () => { clearInterval(timer); timer = null; elapsed = 0; display.textContent = fmt(0); }),
  );
  wrap.append(display, row);
  container.appendChild(wrap);
  ctx.emit("loaded");
}
\`\`\``;

/** System + user messages for one generation pass, for the chosen plugin kind. */
export function buildGenerationMessages(idea: string, kind: PluginKind = "viewer"): AiMessage[] {
  const system = kind === "app" ? SYSTEM_APP : SYSTEM_VIEWER;
  const what = kind === "app" ? "standalone app" : "file-viewer";
  return [
    { role: "system", content: system },
    {
      role: "user",
      content: `Build a Canopy ${what} plugin: ${idea.trim()}\n\nReturn only the two fenced blocks described above.`,
    },
  ];
}

/**
 * System + user messages to *refine* an existing plugin: the model gets the
 * current manifest and source plus a change instruction, and returns the COMPLETE
 * updated plugin in the same two-block format. The plugin kind (and so the system
 * prompt) is inferred from the manifest — an app contributes a detailView, a
 * viewer contributes viewers — so the caller doesn't pass it.
 */
export function buildRefinementMessages(instruction: string, current: GeneratedPlugin): AiMessage[] {
  const isApp = !!current.manifest.contributes?.detailView;
  const system = isApp ? SYSTEM_APP : SYSTEM_VIEWER;
  const manifestJson = JSON.stringify(current.manifest, null, 2);
  return [
    { role: "system", content: system },
    {
      role: "user",
      content:
        `Here is an existing Canopy ${isApp ? "app" : "file-viewer"} plugin. Apply the requested change and ` +
        `return the COMPLETE updated plugin in the same two fenced blocks (a full manifest and a full index.js) ` +
        `— not a diff or only the changed parts. Keep the same manifest id.\n\n` +
        `Current manifest:\n\`\`\`json\n${manifestJson}\n\`\`\`\n\n` +
        `Current index.js:\n\`\`\`js\n${current.source}\n\`\`\`\n\n` +
        `Change to apply: ${instruction.trim()}\n\nReturn only the two fenced blocks described above.`,
    },
  ];
}

/** A fenced ```lang … ``` block. `lang` is lowercased, "" when the model omitted it. */
interface Fence {
  lang: string;
  body: string;
}

/** Languages we treat as the source (index.js) block. */
const CODE_LANGS = new Set(["js", "javascript", "jsx", "mjs", "ts", "typescript", "tsx"]);

/** Every fenced code block in the reply, in order. */
function fencedBlocks(text: string): Fence[] {
  const out: Fence[] = [];
  const re = /```([a-z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ lang: m[1]!.toLowerCase(), body: m[2]!.trim() });
  }
  return out;
}

/** Best-effort: the outermost `{ … }` in a string, for the degraded single-JSON fallback. */
function outermostObject(text: string): string | null {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  return first >= 0 && last > first ? text.slice(first, last + 1) : null;
}

/**
 * Parse a model reply into a {manifest, source}. The contract asks for two fenced
 * blocks — a ```json manifest and a ```js source — which sidesteps the brittle
 * "code packed into a JSON string" escaping that made generation fail across
 * providers. We stay tolerant: a model that still emits the old single JSON object
 * ({ manifest, source }) is accepted too. Throws a readable error otherwise.
 */
export function parseGeneratedPlugin(text: string): GeneratedPlugin {
  const blocks = fencedBlocks(text);
  const code = blocks.find((b) => CODE_LANGS.has(b.lang));
  // The manifest JSON: a json-fenced block, else an unlabeled fence, else the
  // outermost object in the raw reply (covers no-fence and old single-JSON replies).
  const jsonText =
    blocks.find((b) => b.lang === "json")?.body ??
    blocks.find((b) => b.lang === "")?.body ??
    outermostObject(text);

  if (jsonText) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error("the model didn't return valid JSON — try again or pick a different model");
    }
    const obj = parsed as { manifest?: unknown; source?: unknown; id?: unknown };
    // Old shape: a single object carrying both manifest and source.
    if (obj.manifest && typeof obj.manifest === "object") {
      const source = typeof obj.source === "string" && obj.source.trim() ? obj.source : code?.body;
      if (!source) throw new Error("response had no source");
      return { manifest: obj.manifest as PluginManifest, source };
    }
    // New shape: the JSON block IS the manifest; source is the ```js block.
    if (obj.id && code?.body) {
      return { manifest: obj as PluginManifest, source: code.body };
    }
  }
  throw new Error("the model's reply didn't contain a manifest and source — try again or pick a different model");
}
