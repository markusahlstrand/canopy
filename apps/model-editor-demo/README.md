# Canopy Model Editor — Local Demo

A standalone, backend-free web app that runs the **Canopy Model Editor** plugin
(`@canopy/model-editor`) against a **real folder on your machine**. It's the
simplest way to try the visual editors for Prisma schemas, TypeSpec APIs, Arazzo
workflows and AsyncAPI channels without the portal or the VS Code extension.

## How it works

The Model Editor is a trusted plugin that talks to its host through a small
`HostBridge` interface (read/write files, AI, etc.). This app implements that
bridge over the browser's [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API):

- [`src/fs-host-bridge.ts`](src/fs-host-bridge.ts) — the `HostBridge`, where file
  ids are paths relative to the folder you grant access to.
- [`src/main.tsx`](src/main.tsx) — folder picker, file sidebar, and the
  `ModelEditorFileRouter` that dispatches each file to the right canvas.

Edits save straight back to disk. No server, no build step on your files.

## Run it

```sh
pnpm --filter @canopy/model-editor-demo dev
```

Open the printed URL, then either:

- **Open folder** — pick a directory with `.prisma`, `.tsp`, `.arazzo` or `.asyncapi` files
  (edits save back to disk), or
- **Try a sample** — load an in-memory Pet Store schema, no folder needed (handy
  for a quick look or to compare drag performance against a known-small graph).

## Browser support

The File System Access API is Chromium-only — use **Chrome, Edge or Arc**. The
app shows a notice in browsers that don't support it.
