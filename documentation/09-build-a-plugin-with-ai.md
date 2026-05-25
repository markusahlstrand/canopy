# Build a plugin with AI

This page is a **self-contained spec** for building a Canopy plugin — written so a coding agent
(Claude Code, Cursor, etc.) can read this one file and produce a working plugin in a single pass.
Humans can follow it top to bottom too. For the design rationale behind each piece, see
[How plugins work](how-plugins-work) and [Writing a plugin](writing-a-plugin); this page is the
fast path.

> **The 30-second version:** the only plugin kind that runs today with **no host edits** is a
> **sandboxed file viewer**. If you just want to "build your own plugin in minutes", build a viewer.
> There are two ways:
>
> - **In the running app — Plugin Studio** (no setup, no repo edits): open it from the plugin store's
>   "Build your own with AI". Describe the viewer; the deployment's own AI writes it, you preview it
>   live against a sample file, and **Install** persists it and activates it for your account. This is
>   the runtime path — it uses everything below, just driven by the host LLM instead of you.
> - **As code** (this page): run `/new-plugin "describe your idea"` in Claude Code, or follow these
>   steps yourself, to add a viewer to the repo. Use this for first-party/bundled viewers or when you
>   want the source in version control.

---

## 1. Pick the kind of plugin

| You want to… | Kind | Runs today? | Where the code goes |
|---|---|---|---|
| Render/edit a file type in the preview (PDF, image, CSV, 3D, …) | **Viewer** | ✅ Yes | **Plugin Studio** (runtime, no code) — or `examples/plugins/<id>/` + two manifest-driven lists (`bundled-manifests.ts` / `bundled.ts`) |
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

There are two ways to make a viewer run, depending on whether it lives in the app or in the repo.

### Path A — Plugin Studio (runtime install, no repo edit)

This is what the Studio does for you, and the path a generated plugin takes. The viewer is **stored
and installed at runtime**: its `canopy.json` and `index.js` are saved per-user
(`POST /api/plugins/custom`), the manifest is merged into the plugin registry, and its
`contributes.viewers` are merged into the host's viewer resolver — so opening a matching file picks
it up with **no `viewers.ts` change and no rebuild**. Here, `canopy.json` *is* read at runtime: it's
the source of truth for the store card, the registry, and which file types the viewer claims. Uninstall
it from the Studio's "Your generated plugins" list. (Today this path installs **sandboxed viewers**;
a generated plugin can't use host-trusted grants like `ai:generate`.)

### Path B — bundle it in the repo

For a first-party or version-controlled viewer, register the plugin in two manifest-driven lists.
The host **parses your `canopy.json` at runtime**, so its `contributes.viewers` is what decides the
file types the viewer claims — there's no separate viewer entry to keep in sync.

```ts
// apps/portal/src/plugins/bundled-manifests.ts — add a ?raw manifest import + an entry:
import csvManifest from "../../../../examples/plugins/csv-viewer/canopy.json?raw";
export const BUNDLED_MANIFESTS: PluginManifest[] = [
  // …existing… ,
  csvManifest,                 // order here = store / sidebar order
].map((raw) => JSON.parse(raw) as PluginManifest);

// apps/portal/src/plugins/bundled.ts — map the plugin id to its entry source:
import csvSource from "../../../../examples/plugins/csv-viewer/index.js?raw";
const SOURCE_BY_ID: Record<string, string> = {
  // …existing… ,
  "csv-viewer": csvSource,
};
```

That's the whole registration — `VIEWERS` and `CREATORS` are derived from each manifest's
`contributes` in [`viewers.ts`](../apps/portal/src/plugins/viewers.ts). Match precedence is
first-match-wins in the order the plugins are listed, so put a specific viewer before a broad one.

---

## 6. See it run (the feedback loop)

**Plugin Studio (Path A):** the loop is built in — after generating, drop a sample file matching the
viewer's `match` and it renders live in the same sandbox right there. Tweak the idea, regenerate,
preview again; **Install** when it's right.

**Bundled (Path B):**

```bash
pnpm dev          # portal on :5768 + API on :8787 (or: pnpm dev:api & pnpm --filter @canopy/portal dev)
```

Upload a file your `match` covers (e.g. a `.csv`) and open its preview. Your viewer renders inside
the sandbox. If something throws, the preview shows **"Viewer failed to load"** with the error — fix
and the Vite HMR reload picks it up.

> The Studio requires an AI provider for the account (deployment default or one added under
> **Settings → AI**). With none configured it falls back to a copy-paste prompt for an external
> coding agent — i.e. Path B.

---

## 7. Checklist for an AI agent

1. Choose a unique kebab-case `id`. Default to a **viewer** unless told otherwise.
2. Create `examples/plugins/<id>/canopy.json` — valid against `canopy-plugin.schema.json`, with the
   right `match` and the **minimal** capabilities.
3. Create `examples/plugins/<id>/index.js` — `export default render(ctx)`, build DOM from
   `file.bytes`, inline styles only, no host/global access, CDN imports must degrade gracefully.
4. Register it (bundled path): add the manifest to `apps/portal/src/plugins/bundled-manifests.ts`
   and the entry source to `apps/portal/src/plugins/bundled.ts`. `contributes.viewers` drives the
   match; list specific viewers before broad ones. (Or skip this entirely and use the Plugin Studio,
   which installs at runtime.)
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
- Register it (bundled): add the manifest to apps/portal/src/plugins/bundled-manifests.ts and the
  entry source to apps/portal/src/plugins/bundled.ts. contributes.viewers drives the match; list
  specific viewers before broad ones.
- Use the minimal capabilities. Then tell me which file type to drop to test it.
```
