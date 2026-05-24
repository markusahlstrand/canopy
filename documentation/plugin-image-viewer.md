# Image Viewer

Renders images inline in the file preview.

## What it does

A minimal sandboxed viewer: it takes the previewed file's bytes, builds an object URL, and
shows the image. It's the smallest of the bundled viewers and a good reference for the
[viewer contract](build-a-plugin-with-ai).

## At a glance

- **Type:** File viewer (sandboxed)
- **Handles:** `image/*` — `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.heic`, `.avif`
- **Capabilities:** `item:read`
- **Availability:** built-in — always available, not in the store
- **Source:** `examples/plugins/image-viewer/`

## See also

- [Build a plugin with AI](build-a-plugin-with-ai) — the viewer contract, start to finish.
- [PDF Viewer](plugin-pdf-viewer) — a viewer that loads a library from a CDN.
