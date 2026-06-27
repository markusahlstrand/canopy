# Model Editor

Opens data-model and API files in a visual editor instead of plain text — and, more than any other
plugin, shows how far the Canopy plugin boundary travels.

## What it does

The Model Editor renders the files that describe an app's shape as interactive canvases rather than
source text:

| File type | Editor |
| --- | --- |
| `.prisma` | Visual Prisma schema / ER editor |
| `.tsp` | TypeSpec entities + endpoints |
| `.arazzo`, `.arazzo.yaml/.yml/.json` | Arazzo workflow builder |
| `.asyncapi`, `.asyncapi.yaml/.yml/.json` | AsyncAPI channels (events) |

Edits round-trip back to the file. In the portal it opens from the file preview surface; it also
runs as a library-style scratch editor that persists models to `localStorage`.

## One view, three hosts

The Model Editor is the reference example of the [plugin SDK boundary](how-plugins-work). It's a
*trusted first-party* view, but it still reaches its host only through the `@canopy/plugin-sdk`
`HostBridge` (file I/O, AI, theme) — never app internals. An ESLint rule enforces that on
`src/components/model-editor/**`.

Because the view depends on nothing but the bridge, the **exact same `@canopy/model-editor`
component tree runs in three different hosts** — each one just reimplements the bridge:

- **Canopy portal** — the bridge talks to the Canopy API (`apps/portal/src/plugins/host-bridge.ts`).
- **VS Code extension** (`apps/vscode-model-editor`) — a `CustomTextEditorProvider` owns the
  `TextDocument`; the bridge proxies file reads/writes over webview `postMessage`, and
  `host.aiGenerate` is wired to VS Code's Language Model API (Copilot). Ships as
  `canopy-model-editor.vsix`.
- **Standalone demo** (`apps/model-editor-demo`) — a backend-free web app where the bridge runs over
  the browser's File System Access API, editing a real folder on disk. No server, no Canopy backend.

Same view, three hosts, three `HostBridge` implementations. That's the portability the SDK boundary
buys, shipped rather than hypothetical.

> **Try it live →** [Open `main.tsp` in the Model Editor](?space=connector:github&path=examples/specs/petstore&open=main.tsp)
> — this opens a real TypeSpec file from Canopy's own repo, mounted as a read-only
> [GitHub-connected space](architecture). Two plugins working together: the GitHub connector
> mounts the repo as a browsable space, and the Model Editor opens the spec on its canvas. No sign-in
> needed — both are available to demo visitors.

## At a glance

- **Type:** File editor (trusted first-party React, registered as a `FileView` in `PLUGIN_UI`)
- **Contributes:** a file view for `.prisma` / `.tsp` / `.arazzo` / `.asyncapi`
- **Capabilities:** file read/write and AI generation, via the `HostBridge`
- **Boundary:** `@canopy/plugin-sdk` only, lint-enforced on `src/components/model-editor/**`
- **Also runs as:** a VS Code extension (`apps/vscode-model-editor`) and a backend-free standalone
  app (`apps/model-editor-demo`)

## See also

- [How plugins work](how-plugins-work) — the trust tiers and the `HostBridge` capability model.
- [Writing a plugin](writing-a-plugin) — why keeping a view on the SDK makes it host-portable.
- [Built-in plugins](built-in-plugins) — the rest of what ships with Canopy.
