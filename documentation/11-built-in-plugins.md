# Built-in plugins

Canopy ships with a set of first-party plugins so the app is useful the moment it's
running — and so each one doubles as a worked example of the plugin model described in
[How plugins work](how-plugins-work). Everything here is "just a plugin": nothing in this
list has privileges a plugin you write couldn't also declare.

They come in two flavours:

- **Apps** add UI you open from the sidebar or right rail — a full detail view, a rail
  panel, context-menu actions — and sometimes feed typed records (tasks, calendar events)
  or derive metadata server-side.
- **File viewers & editors** render (and sometimes edit) a file type in the preview
  surface. Their code runs untrusted, inside a sandboxed opaque-origin iframe, and only
  ever sees the one file being previewed.

## How they're enabled

Two different switches, depending on the plugin:

- **Store apps** are installed and uninstalled from the plugin store. Calendar and Tasks
  are installed by default; the rest you add when you want them. Signed-out visitors also
  get Documentation, which doubles as the landing experience.
- **Built-in viewers** (Image, PDF, Markdown, Univer Office) aren't in the store — they're
  always available, so common file types open without an install step.
- **Code Editor** is the exception that ties the two together: it's a viewer *and* a store
  app, so it's install-gated — code files only open in it once it's installed.

## Apps

| Plugin | What it does |
|---|---|
| [Calendar](plugin-calendar) | Upcoming events as a detail view + an "Up next" rail panel |
| [Tasks](plugin-tasks) | A shared to-do list, with "Create task from file" |
| [GitHub](plugin-github) | A data source feeding issues → Tasks and releases → Calendar |
| [Synology](plugin-synology) | A storage connector browsing a Synology NAS as a space (direct, Tailscale, or QuickConnect) |
| [Document AI](plugin-document-ai) | Auto-labels each document by type with an AI model |
| [Documentation](plugin-documentation) | Renders these docs from the read-only docs mount |

## File viewers & editors

| Plugin | Handles |
|---|---|
| [Image Viewer](plugin-image-viewer) | PNG, JPEG, GIF, WebP, SVG, HEIC, AVIF |
| [PDF Viewer](plugin-pdf-viewer) | PDF (rendered with pdf.js) |
| [Markdown Editor](plugin-markdown-editor) | Markdown — view, edit, and mermaid diagrams |
| [Univer Office](plugin-univer-office) | Spreadsheets (CSV/TSV) and Univer documents |
| [Code Editor](plugin-code-editor) | Source code, with the VS Code editor (Monaco) |

## Model & API editor

| Plugin | Handles |
|---|---|
| [Model Editor](plugin-model-editor) | `.prisma` (ER/schema), `.tsp` (TypeSpec), `.arazzo` (workflows), `.asyncapi` (events) |

Unlike the sandboxed viewers above, the **Model Editor** is a *trusted first-party* file editor —
it ships as React in `PLUGIN_UI`, reaching the host only through the `@canopy/plugin-sdk`
`HostBridge`. That discipline makes it Canopy's clearest **proof of the architecture's
flexibility**: the exact same `@canopy/model-editor` view runs in three different hosts, each just
reimplementing the bridge — the Canopy portal, a [VS Code extension](plugin-model-editor)
(`apps/vscode-model-editor`), and a backend-free [standalone web app](plugin-model-editor)
(`apps/model-editor-demo`). One view, three hosts, three bridges.

## Search (⌘K)

A **⌘K / Ctrl-K command palette** searches files by name, content, and AI labels and jumps to a
result, querying the host's ACL-scoped `GET /api/search`. Unlike everything above it currently
ships **in the shell**, not as a registered plugin — it's slated to become a plugin contribution
once the `index:query` → `queryIndex()` grant lands. See
[What belongs in the core → search](what-belongs-in-the-core).

## See also

- [How plugins work](how-plugins-work) — the roles, trust levels, and capability model.
- [Writing a plugin](writing-a-plugin) — building one of the deeper plugin kinds.
- [Build a plugin with AI](build-a-plugin-with-ai) — the fast path for a sandboxed viewer.
