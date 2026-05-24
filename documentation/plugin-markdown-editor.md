# Markdown Editor

View **and edit** Markdown, with live diagrams.

## What it does

A rich Markdown editor built on Toast UI Editor (loaded from a CDN), with ```mermaid fenced
blocks rendered as diagrams in the preview. Edits save back to the file with ⌘/Ctrl-S — the
sandboxed viewer emits the new content and the host writes it to that one file. If the CDN
is unreachable it falls back to a plain-text editor so editing still works offline. It also
registers a **"Markdown document"** entry in the host's *New* menu.

## At a glance

- **Type:** File viewer + editor (sandboxed)
- **Handles:** `text/markdown`, `.md`, `.markdown`, `.mdx`
- **Capabilities:** `item:read`, `item:write`
- **Creates:** "Markdown document" (`.md`)
- **Availability:** built-in — always available, not in the store
- **Source:** `examples/plugins/markdown-editor/`

## See also

- [Code Editor](plugin-code-editor) — the same editor/save pattern for source code.
- [Build a plugin with AI](build-a-plugin-with-ai) — the editor save handshake.
