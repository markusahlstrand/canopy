# Canopy Model Editor (VS Code)

The Canopy **Model Editor** plugin, packaged as a VS Code extension. It opens
data-model and API files in a visual editor instead of plain text:

| File type | Editor |
| --- | --- |
| `.prisma` | Visual Prisma schema / ER editor |
| `.tsp` | TypeSpec entities + endpoints |
| `.arazzo`, `.arazzo.yaml/.yml/.json` | Arazzo workflow builder |
| `.asyncapi`, `.asyncapi.yaml/.yml/.json` | AsyncAPI channels (events) |

The UI is the exact same React component tree (`@canopy/model-editor`) used by the
Canopy portal. The only thing that differs per host is the `HostBridge`: in the
portal it talks to the Canopy API; here it talks to the VS Code extension host
over `postMessage`.

## Install

Download `canopy-model-editor.vsix` from the
[latest release](https://github.com/markusahlstrand/canopy/releases/latest), then:

```sh
code --install-extension canopy-model-editor.vsix
```

…or in VS Code: **Extensions panel → ⋯ → Install from VSIX…**.

## Get started

Run **Canopy Model Editor: Create Sample Project** from the Command Palette (or the
"Create a sample project" button in the extension's Walkthrough) to drop a small
Pet Store project — `schema.prisma`, `main.tsp`, `workflow.arazzo.yaml`,
`events.asyncapi.yaml` — into a folder and open it in the editor. Or just open any
existing `.prisma` / `.tsp` / `.arazzo` / `.asyncapi` file.

## How it works

- **Custom editor** — `ModelEditorProvider` (a `CustomTextEditorProvider`) owns the
  `TextDocument`; the webview is the UI. See [src/editorProvider.ts](src/editorProvider.ts).
- **HostBridge over postMessage** — file reads/writes, sibling discovery and the
  "new document" action are proxied to the extension and served from the workspace
  filesystem ([src/files.ts](src/files.ts)). Saving the canvas replaces the
  document text and persists it; external/text edits are pushed back so the canvas
  reloads. See [webview/host-bridge.ts](webview/host-bridge.ts).
- **AI assistant** — `host.aiGenerate` is bridged to VS Code's Language Model API
  (Copilot); no Canopy backend or API key is involved. See [src/ai.ts](src/ai.ts).
- **Theme** — the active VS Code theme is mapped to the `.dark` class the shared UI
  and React Flow read. See [webview/theme.ts](webview/theme.ts).

## Develop

```sh
pnpm install            # from the repo root
pnpm --filter canopy-model-editor build
```

Then press **F5** (Run "Run Model Editor Extension") to launch an Extension
Development Host, and open a `.prisma` / `.tsp` / `.arazzo` / `.asyncapi` file. For iterative
work run both watchers (host + webview) in one terminal:

```sh
pnpm --filter canopy-model-editor dev
```

After a host (`src/*.ts`) change, reload the dev-host window (`Cmd+R`); after a
webview change, just reopen the file's editor tab.

## Package

```sh
pnpm --filter canopy-model-editor package   # → canopy-model-editor.vsix
```

The webview is bundled by Vite, the extension host by esbuild; only `dist/` ships
in the `.vsix` (see [.vscodeignore](.vscodeignore)).
