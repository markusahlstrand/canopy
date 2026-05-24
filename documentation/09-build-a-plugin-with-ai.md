# Build a plugin with AI

This page is a **self-contained spec** for building a Canopy plugin — written so a coding agent
(Claude Code, Cursor, etc.) can read this one file and produce a working plugin in a single pass.
Humans can follow it top to bottom too. For the design rationale behind each piece, see
[How plugins work](how-plugins-work) and [Writing a plugin](writing-a-plugin); this page is the
fast path.

> **The 30-second version:** the only plugin kind that runs today with **no host edits beyond one
> registration line** is a **sandboxed file viewer**. If you just want to "build your own plugin in
> minutes", build a viewer. Run `/new-plugin "describe your idea"` in Claude Code and it does
> everything below for you.

---

## 1. Pick the kind of plugin

| You want to… | Kind | Runs today? | Where the code goes |
|---|---|---|---|
| Render/edit a file type in the preview (PDF, image, CSV, 3D, …) | **Viewer** | ✅ Yes | `examples/plugins/<id>/index.js` + one line in `viewers.ts` |
| Add a full-page tool or rail panel opened from the sidebar | **UI slot** | ✅ Yes (sandboxed) | `examples/plugins/<id>/index.js` (a `render(ctx)` per slot) + one line in `ui.ts`; or first-party React in `PLUGIN_UI` |
| Feed external data into Tasks / Calendar | **Data source** | ⚠️ Server-side wiring | `apps/api/src/data-sources.ts` |
| Add a new storage backend | **Connector** | ✅ Yes | A `packages/connectors/*` package |

**If you're an AI agent and the user didn't specify: build a viewer.** It's the one with a real,
fast feedback loop and the least host surface to touch. The rest of this page is the viewer path;
the others are covered in [Writing a plugin](writing-a-plugin).

---

## 2. The viewer contract (read this once)

A viewer's entry module runs **inside an `<iframe sandbox="allow-scripts">` with no
`allow-same-origin`** — an opaque origin. That means, hard constraints:

- **No** access to the host page, its DOM, cookies, `localStorage`, or same-origin network.
- The host hands you **only the one file being previewed** — nothing else.
- You **may** `import()` from a CDN (e.g. `https://esm.sh/...`) and use `fetch` to public URLs.
  Always degrade gracefully if the CDN is blocked.
- You render plain DOM into a container. No React, no host CSS — inline styles only.

The entry module **exports a default `render(ctx)`**:

```js
// ctx.container : HTMLElement       — render into this
// ctx.file      : { name, mime, bytes: ArrayBuffer, writable: boolean }
// ctx.emit      : (action, data?) => void   — send a message to the host
export default function render(ctx) {
  const { container, file } = ctx;
  // ...build DOM from file.bytes, append to container...
}
```

`render` may be `async`. The host auto-resizes the iframe to your content's height (120–1600px),
so don't manage outer layout.

### Reading the bytes

```js
// Binary (image, pdf, …):
const url = URL.createObjectURL(new Blob([file.bytes], { type: file.mime }));
// Text (markdown, csv, json, …):
const text = new TextDecoder().decode(new Uint8Array(file.bytes));
```

### Saving (editors only)

Declare `item:write`. The host gives you `file.writable = true` and accepts a save:

```js
ctx.emit("save", { content });   // host writes it back to THIS file only

// listen for the result:
addEventListener("message", (e) => {
  if (e.data?.type !== "canopy:save-result") return;
  if (e.data.ok) { /* saved ✓ */ } else { /* e.data.error */ }
});
```

> Editor save-back is currently gated host-side by a check in
> `apps/portal/src/components/file-preview.tsx` (`viewer?.plugin === "markdown-editor"`). For a new
> editor, extend that condition to include your plugin id. A read-only viewer needs none of this.

---

## 3. The manifest (`canopy.json`)

Every plugin has a `canopy.json`. It's validated by
[`canopy-plugin.schema.json`](canopy-plugin.schema.json) — add the `$schema` line for editor
autocomplete. A minimal **viewer** manifest:

```json
{
  "$schema": "../../../documentation/canopy-plugin.schema.json",
  "id": "csv-viewer",
  "name": "CSV Viewer",
  "version": "0.1.0",
  "description": "Renders CSV files as a table.",
  "icon": "table",
  "color": "160 60% 45%",
  "entry": "index.js",
  "capabilities": [{ "kind": "item:read" }],
  "contributes": {
    "viewers": [
      { "id": "csv", "title": "CSV", "match": ["text/csv", ".csv", ".tsv"] }
    ],
    "store": { "category": "Productivity", "tagline": "View spreadsheets inline." }
  }
}
```

Field reference (full list in the schema):

- `id` — kebab-case, unique, stable. `name` — display name. `version` — semver.
- `icon` — a [lucide](https://lucide.dev) icon name. `color` — HSL **without** `hsl()`, e.g. `"160 60% 45%"`.
- `capabilities` — declare only what you use. A read-only viewer needs just `{ "kind": "item:read" }`;
  an editor adds `{ "kind": "item:write" }`; a viewer that calls an API adds
  `{ "kind": "net:fetch", "hosts": ["example.com"] }`.
- `contributes.viewers[].match` — exact MIME (`"application/pdf"`), MIME wildcard (`"image/*"`),
  dot-extension (`".csv"`), or bare extension (`"csv"`). The host picks the **first** viewer whose
  `match` covers the file.
- `contributes.store` — category + tagline for the plugin store card.

---

## 4. Scaffold the plugin

Create `examples/plugins/<id>/` with two files:

```
examples/plugins/csv-viewer/
├── canopy.json     ← the manifest above
└── index.js        ← export default render(ctx)
```

A complete, working read-only viewer (`index.js`):

```js
// Canopy viewer plugin — runs in a sandboxed, opaque-origin iframe.
// Contract: export default render(ctx) with ctx.{container, file, emit}.
export default function render(ctx) {
  const { container, file } = ctx;
  const text = new TextDecoder().decode(new Uint8Array(file.bytes));
  const rows = text.trim().split(/\r?\n/).map((line) => line.split(","));

  const table = document.createElement("table");
  table.style.cssText = "border-collapse:collapse;width:100%;font:13px system-ui,-apple-system,sans-serif";
  rows.forEach((cells, r) => {
    const tr = document.createElement("tr");
    cells.forEach((cell) => {
      const el = document.createElement(r === 0 ? "th" : "td");
      el.textContent = cell;
      el.style.cssText =
        "border:1px solid #d1d5db;padding:6px 10px;text-align:left" + (r === 0 ? ";font-weight:600" : "");
      tr.appendChild(el);
    });
    table.appendChild(tr);
  });
  container.appendChild(table);
  ctx.emit("loaded", { rows: rows.length });
}
```

Study the bundled examples for more shapes — they're the reference implementations:

- `examples/plugins/image-viewer/` — minimal binary viewer.
- `examples/plugins/pdf-viewer/` — loads pdf.js from a CDN, renders to `<canvas>`, falls back to a
  download link if the CDN is blocked.
- `examples/plugins/markdown-editor/` — the full **editor**: `item:write`, CDN editor with an
  offline plain-text fallback, ⌘/Ctrl-S save, and the `canopy:save-result` handshake.

---

## 5. Register it so it actually runs

There is **no runtime upload/install flow yet** — viewers are bundled at build time. To make a new
viewer run, add it to [`apps/portal/src/plugins/viewers.ts`](../apps/portal/src/plugins/viewers.ts):

```ts
// 1) import the entry source as raw text (Vite ?raw):
import csvViewerSource from "../../../../examples/plugins/csv-viewer/index.js?raw";

// 2) add an entry to the VIEWERS array. ORDER MATTERS — the first match wins,
//    so put specific matchers above broad ones (e.g. ".csv" before a "text/*").
export const VIEWERS: InstalledViewer[] = [
  {
    plugin: "csv-viewer",
    id: "csv",
    title: "CSV",
    match: ["text/csv", ".csv", ".tsv"],
    source: csvViewerSource,
  },
  // …existing entries…
];
```

That's the whole registration. (The `canopy.json` isn't read at runtime today — it's the
forward-compatible manifest for when the resolver in `@canopy/plugin-sources` is wired to the app.
Keep it correct anyway; it's the source of truth for the store and the future loader.)

---

## 6. See it run (the feedback loop)

```bash
pnpm dev          # portal on :5768 + API on :8787 (or: pnpm dev:api & pnpm --filter @canopy/portal dev)
```

Upload a file your `match` covers (e.g. a `.csv`) and open its preview. Your viewer renders inside
the sandbox. If something throws, the preview shows **"Viewer failed to load"** with the error — fix
and the Vite HMR reload picks it up.

---

## 7. Checklist for an AI agent

1. Choose a unique kebab-case `id`. Default to a **viewer** unless told otherwise.
2. Create `examples/plugins/<id>/canopy.json` — valid against `canopy-plugin.schema.json`, with the
   right `match` and the **minimal** capabilities.
3. Create `examples/plugins/<id>/index.js` — `export default render(ctx)`, build DOM from
   `file.bytes`, inline styles only, no host/global access, CDN imports must degrade gracefully.
4. Wire it into `apps/portal/src/plugins/viewers.ts`: a `?raw` import + a `VIEWERS` entry, specific
   matchers before broad ones.
5. If it's an **editor**: add `item:write`, implement the `save`/`canopy:save-result` handshake, and
   extend the editor gate in `file-preview.tsx`.
6. Validate the manifest against the schema, then tell the user to run `pnpm dev` and open a matching
   file.

---

## A ready-to-paste prompt

If you're driving an AI yourself (instead of the `/new-plugin` skill), paste this, filling in the idea:

```
Build a Canopy file-viewer plugin: <DESCRIBE IT, e.g. "render .gpx GPS tracks on a small map">.

Follow documentation/09-build-a-plugin-with-ai.md exactly. Specifically:
- Create examples/plugins/<id>/canopy.json (valid against documentation/canopy-plugin.schema.json)
  and examples/plugins/<id>/index.js (export default render(ctx)).
- The entry runs in an opaque-origin sandboxed iframe: only ctx.file (name, mime, bytes, writable),
  no host DOM/cookies/storage, inline styles only. CDN import() is allowed but must degrade gracefully.
- Register it in apps/portal/src/plugins/viewers.ts (a ?raw import + a VIEWERS entry; specific
  matchers before broad ones).
- Use the minimal capabilities. Then tell me which file type to drop to test it.
```
