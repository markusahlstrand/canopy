# Example plugins

Reference plugins for Canopy. Each folder is a real, working plugin you can copy.

| Plugin | Kind | Shows |
|---|---|---|
| [`image-viewer`](image-viewer) | viewer | Minimal binary viewer — render bytes as an `<img>`. |
| [`pdf-viewer`](pdf-viewer) | viewer | CDN library (pdf.js) → `<canvas>`, with an offline fallback. |
| [`markdown-editor`](markdown-editor) | viewer + editor | `item:write`, the save handshake, CDN editor with a plain-text fallback. |
| [`hello`](hello) | server hook | A tiny `enrichItem` hook (manifest + capability shape). |

## Build your own

The fastest path is the `/new-plugin` Claude Code skill — `/new-plugin "render .gpx tracks on a map"`
— which scaffolds, writes, and wires a viewer for you.

To do it by hand (or to understand what the skill does), follow the self-contained spec:
[**documentation/09-build-a-plugin-with-ai.md**](../../documentation/09-build-a-plugin-with-ai.md).
Manifests are validated by [`documentation/canopy-plugin.schema.json`](../../documentation/canopy-plugin.schema.json).

> A viewer runs once you add it to [`apps/portal/src/plugins/viewers.ts`](../../apps/portal/src/plugins/viewers.ts)
> (a `?raw` import + a `VIEWERS` entry) and restart `pnpm dev`. There is no runtime upload flow yet.
