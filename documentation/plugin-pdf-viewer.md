# PDF Viewer

Renders PDFs inline, page by page.

## What it does

The browser's native PDF viewer is blocked inside a sandboxed frame, so this viewer renders
with **pdf.js** to a `<canvas>` instead — pure JS, no plugin needed. pdf.js is loaded from a
CDN; if the network is blocked the viewer degrades gracefully to a download link rather than
failing. A good reference for a viewer that depends on an external library.

## At a glance

- **Type:** File viewer (sandboxed)
- **Handles:** `application/pdf`, `.pdf`
- **Capabilities:** `item:read`
- **Availability:** built-in — always available, not in the store
- **Source:** `examples/plugins/pdf-viewer/`

## See also

- [Image Viewer](plugin-image-viewer) — the minimal viewer without a CDN dependency.
- [Build a plugin with AI](build-a-plugin-with-ai) — CDN imports and graceful fallback.
