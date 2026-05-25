---
name: new-plugin
description: Scaffold a new Canopy plugin from a one-line idea — writes the manifest + entry code, wires it into the app, and tells the user how to test it. Use when the user wants to create/build/scaffold a Canopy plugin (most often a sandboxed file viewer or editor), e.g. "/new-plugin render .gpx tracks on a map" or "build me a plugin that shows EXIF data for photos".
---

# Build a new Canopy plugin

You scaffold a working Canopy plugin from the user's idea (passed as arguments), end to end:
choose the kind, write the manifest + entry code, register it so it runs, validate, and hand the
user a one-line test instruction.

## Step 0 — Read the contract first

Before writing anything, read these so you match the real shapes exactly:

- `documentation/09-build-a-plugin-with-ai.md` — the authoring spec (the source of truth).
- `documentation/canopy-plugin.schema.json` — the manifest schema you must validate against.
- At least one example whose kind matches the idea:
  - read/render a file → `examples/plugins/image-viewer/{index.js,canopy.json}`
  - load a CDN library → `examples/plugins/pdf-viewer/index.js`
  - edit + save a file → `examples/plugins/markdown-editor/index.js`
- `apps/portal/src/plugins/bundled-manifests.ts` + `bundled.ts` — where you register a bundled
  viewer (manifest list + id→source map; `viewers.ts` derives `VIEWERS` from them).

Do not invent fields or capabilities. If something isn't in the schema or the spec, it doesn't exist.

## Step 1 — Decide the kind

Default to a **sandboxed viewer** (or editor, if the idea is about changing the file). It's the only
kind with a fast, no-host-rewrite feedback loop. Only build a detail-view / data-source / connector
if the user explicitly asks for one — and if so, follow `documentation/05-writing-a-plugin.md`
instead and tell the user it needs deeper host wiring.

If the idea is ambiguous, make the smallest reasonable assumption, state it, and proceed — don't
block on questions unless the file type to handle is genuinely unclear.

## Step 2 — Pick id + match

- `id`: short, unique, kebab-case (e.g. `gpx-viewer`). Check `examples/plugins/` and
  `bundled-manifests.ts` to avoid collisions.
- `match`: the MIME types / extensions this viewer handles. Be specific (e.g. `[".gpx", "application/gpx+xml"]`).
- Pick a sensible lucide `icon` and an HSL `color` (e.g. `"160 60% 45%"`).

## Step 3 — Scaffold the files

Create `examples/plugins/<id>/canopy.json` and `examples/plugins/<id>/index.js`.

`canopy.json` must start with `"$schema": "../../../documentation/canopy-plugin.schema.json"`,
declare the **minimal** capabilities (`item:read` for a viewer; add `item:write` for an editor; add
`net:fetch` with an explicit `hosts` list only if it calls an API), and include a `contributes.viewers`
entry plus a `contributes.store` listing.

`index.js` must:

- `export default function render(ctx)` (may be `async`).
- Use only `ctx.container`, `ctx.file` (`{ name, mime, bytes, writable }`), and `ctx.emit`.
- Build the file from bytes: `URL.createObjectURL(new Blob([file.bytes], { type: file.mime }))` for
  binary, `new TextDecoder().decode(new Uint8Array(file.bytes))` for text.
- Use **inline styles only** — no host CSS, no React, no access to `window.parent`, cookies, or storage.
- If it imports from a CDN (`import("https://esm.sh/...")`), wrap it in try/catch and degrade
  gracefully (a plain fallback, or a clear message) — the sandbox may block the network.
- `emit("loaded", …)` on success and handle errors by rendering a short message into `container`.

For an **editor** also: read the spec's save section, emit `save` with `{ content }`, listen for
`canopy:save-result`, and in Step 4 extend the editor gate.

## Step 4 — Register it so it runs

The manifest is the source of truth: `VIEWERS` (and `CREATORS`) are derived from each bundled
plugin's `contributes`, so you register the plugin in two manifest-driven lists — no `VIEWERS` entry
to hand-write.

1. In `apps/portal/src/plugins/bundled-manifests.ts`: add a raw import
   `import <id>Manifest from "../../../../examples/plugins/<id>/canopy.json?raw";` and add it to the
   `BUNDLED_MANIFESTS` array (order = store/sidebar order).
2. In `apps/portal/src/plugins/bundled.ts`: add a raw import
   `import <id>Source from "../../../../examples/plugins/<id>/index.js?raw";` and add `"<id>": <id>Source`
   to `SOURCE_BY_ID`.

**Match precedence** is first-match-wins in the order plugins are listed, so place a specific viewer
(via its manifest order) above broad ones.

If you built an **editor**, also extend the gate in `apps/portal/src/components/file-preview.tsx`
(the `viewer?.plugin === "markdown-editor"` check) to include your plugin id, and confirm
`onSaveContent` is wired.

## Step 5 — Validate

Check the manifest against `documentation/canopy-plugin.schema.json` (required fields present, no
unknown keys, capability `kind`s valid, `color` in `"H S% L%"` form, `match` non-empty). Quick check:

```bash
node -e "const m=require('./examples/plugins/<id>/canopy.json');console.log('id',m.id,'caps',JSON.stringify(m.capabilities))"
```

Confirm `index.js` parses (no syntax error) and exports a default function.

## Step 6 — Hand off

Tell the user, concretely:

- What you built and which capabilities it uses (and why each is needed).
- Exactly how to test: `pnpm dev`, then upload/open a file matching `<match>` (name a concrete
  example, e.g. "drop any `.gpx` file and open its preview").
- That a failed render shows "Viewer failed to load" with the error in the preview surface.
- Any CDN dependency and its offline fallback behavior.

Keep the final summary tight. Do not commit or push unless asked.
