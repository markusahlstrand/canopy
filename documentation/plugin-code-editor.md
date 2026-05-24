# Code Editor

Edit source code inline with the **VS Code editor** (Monaco).

## What it does

Code Editor mounts Monaco — the editor that powers VS Code — in the sandboxed preview,
loaded from a CDN. It detects the language from the file extension (JS/TS, Python, Go, Rust,
CSS, YAML, shell, SQL, and many more) for syntax highlighting, and saves edits back to the
file with ⌘/Ctrl-S. Monaco's language-service web workers are bootstrapped from a same-origin
blob — required because the preview frame runs at an opaque origin. If the CDN is blocked it
falls back to a plain monospace text area that's still fully editable and saveable.

## At a glance

- **Type:** File viewer + editor (sandboxed)
- **Handles:** common source and config files — `.js`, `.jsx`, `.ts`, `.tsx`, `.json`,
  `.py`, `.rb`, `.go`, `.rs`, `.java`, `.c`, `.cpp`, `.cs`, `.php`, `.swift`, `.kt`, `.sh`,
  `.sql`, `.yaml`, `.toml`, `.xml`, `.css`, `.scss`, `.html`, and more
- **Capabilities:** `item:read`, `item:write`
- **Availability:** in the store and **install-gated** — code files open in it only once
  it's installed; not installed by default
- **Category:** Productivity
- **Source:** `examples/plugins/code-editor/`

## See also

- [Markdown Editor](plugin-markdown-editor) — the same sandboxed editor/save pattern.
- [Build a plugin with AI](build-a-plugin-with-ai) — how this plugin was scaffolded.
