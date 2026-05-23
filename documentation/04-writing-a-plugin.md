# Writing a plugin

The page you're reading is rendered by a plugin. The **Documentation plugin** is a good first example
because it touches both halves of the system: it declares a storage capability and it
contributes a UI view. We'll build it up step by step — every snippet below is the real code.

> While the dynamic runtime is still planned, plugins are wired in as first-party modules. The
> manifest, capability, and contribution parts are exactly what a sandboxed plugin will use;
> only the "ship the React" step changes later.

## 1. Declare the manifest

A plugin starts as a `PluginManifest`. The Documentation plugin asks for read access to one storage
mount and says it contributes a full-page detail view:

```ts
// apps/portal/src/plugins/manifests.ts
const documentation: PluginManifest = {
  id: "documentation",
  name: "Documentation",
  version: "0.1.0",
  icon: "book",
  color: "212 70% 48%",
  capabilities: [{ kind: "storage:read", connectors: ["documentation"] }],
  contributes: {
    detailView: { id: "documentation-detail", title: "Documentation" },
  },
};
```

That's the entire declarative surface. The host now knows Documentation exists, what it's allowed to
touch, and that it owns a detail view.

## 2. Register it

Installed plugins are registered into the `PluginRegistry`. The host queries the registry to
build the sidebar, rail, context menus, and store — so registering is all it takes to appear:

```ts
// apps/portal/src/plugins/index.tsx
export function createRegistry(installedIds: string[]): PluginRegistry {
  const registry = new PluginRegistry();
  for (const id of installedIds) {
    const manifest = buildManifest(id);
    if (manifest) registry.register(manifest);
  }
  return registry;
}
```

Documentation ships in the store catalog (under **Help**). It's installed by default only for
signed-out / anonymous visitors — `ANON_DEFAULT_INSTALLED`, where it doubles as the landing
page; signed-in users add it from the store like any other plugin. Either way, once it's in a
user's install set it's registered through `buildManifest` (above) and shows up in the sidebar
under "Plugins". Which plugins a user has installed is [persisted per user](how-plugins-work).

## 3. Build the view, using only granted access

The plugin's job is to read markdown from the `documentation` mount and render it. It reaches storage
through the host API — the same `?mount=documentation` it declared a capability for — never directly:

```tsx
// apps/portal/src/plugins/documentation-view.tsx (trimmed)
export function DocumentationView() {
  const [docs, setDocs] = useState<FileItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");

  useEffect(() => {
    listFiles("", "documentation").then((items) => {  // GET /api/files?mount=documentation
      const md = items.filter((f) => /\.md$/i.test(f.name));
      setDocs(md);
      setSelected((s) => s ?? md[0]?.path ?? null);
    });
  }, []);

  useEffect(() => {
    if (selected) readText(selected, "documentation").then(setContent);   // GET /api/file?mount=documentation
  }, [selected]);

  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>;
}
```

The data path end to end:

```
DocumentationView ─ listFiles("", "documentation") ─► GET /api/files?mount=documentation
                                       └─ @canopy/api picks the "documentation" connector
                                            └─ @canopy/connector-local reads ./documentation
```

## 4. Connect the view to the contribution

The manifest said "I have a detail view." The portal needs to know _which component_ that is.
Until the sandbox can ship plugin code, that mapping lives in `PLUGIN_UI`:

```ts
// apps/portal/src/plugins/index.tsx
export const PLUGIN_UI: Record<string, PluginUI> = {
  documentation: { DetailView: DocumentationView },
  // …
};
```

When you open Documentation from the sidebar, the host looks up `PLUGIN_UI["documentation"].DetailView` and
renders it in the content area. That's the whole plugin.

## File viewers (sandboxed)

A **viewer** is a plugin that renders a file type in the preview surface — a PDF, an image,
a 3D model. Unlike the detail views above, viewer code is **untrusted**: it runs inside an
`<iframe sandbox="allow-scripts">` with **no** `allow-same-origin`, so the frame gets a unique
*opaque origin* and can't read the host's DOM, cookies, or storage. The document is supplied
via `srcdoc`, so there's no second domain to deploy.

Declare the viewer and the file types it handles in the manifest:

```json
// examples/plugins/image-viewer/canopy.json
{
  "id": "image-viewer",
  "name": "Image Viewer",
  "version": "0.1.0",
  "entry": "index.js",
  "capabilities": [{ "kind": "item:read" }],
  "contributes": {
    "viewers": [{ "id": "image", "title": "Image", "match": ["image/*", ".heic", ".png"] }]
  }
}
```

`match` entries are exact MIME types (`"application/pdf"`), MIME wildcards (`"image/*"`), or
extensions (`".heic"` / `"pdf"`). The host's `viewerMatches()` picks the first viewer whose
`match` covers the previewed file.

The entry module exports a default `render(ctx)`. The host does the privileged work — it
fetches the file's bytes from the API — and hands the sandbox **only that one file**:

```js
// examples/plugins/image-viewer/index.js
export default function render(ctx) {
  // ctx.file = { name, mime, bytes: ArrayBuffer }   ← the only thing we're given
  // ctx.container = the element to render into
  // ctx.emit(action, data) = message the host
  const url = URL.createObjectURL(new Blob([ctx.file.bytes], { type: ctx.file.mime }));
  const img = document.createElement("img");
  img.src = url;
  ctx.container.appendChild(img);
}
```

That's the whole capability handoff: a viewer sees the file it's previewing and nothing else.
The host auto-resizes the frame to its content, so plugins don't manage layout. The bridge
protocol (host ↔ iframe `postMessage`) lives in `apps/portal/src/components/plugin-viewer.tsx`;
`PluginViewer` is mounted from the file preview when a viewer matches. See
`examples/plugins/pdf-viewer` for a PDF showcase — the browser's native PDF plugin is blocked
inside a sandboxed frame, so it renders with **pdf.js to a `<canvas>`** (loaded from a CDN,
with a blob-backed worker so it runs under the opaque origin), falling back to a download link
if pdf.js can't load.

### Editing — the write half of the handoff

A viewer can also **edit**. The host hands the file in with a `writable` flag; to save, the
plugin emits `save` with the new content, and the host writes it back — but only to the file
currently being previewed, never a path the plugin chooses:

```js
ctx.emit("save", { content });        // → host PUTs to this one file
// host replies: { type: "canopy:save-result", ok, error? }
```

`examples/plugins/markdown-editor` is the full example: it declares `item:write`, mounts
[Toast UI Editor](https://ui.toast.com/tui-editor) (a rich Markdown + WYSIWYG editor, loaded
from a CDN), and saves with ⌘/Ctrl-S or the Save button. If the CDN is unreachable it degrades
to a plain-text editor that still saves. The host performs the write through the same
`PUT /api/file` the drive uses, so per-user scoping and the storage connector apply unchanged.

## Adding a storage connector instead

A connector is the other kind of plugin. You implement `StorageConnector` and a factory, then
mount it in the API. The shape (from `@canopy/connector-local`):

```ts
export const localConnectorPlugin: StorageConnectorPlugin = {
  type: "local",
  label: "Local filesystem",
  configFields: [{ key: "root", label: "Root directory", type: "string", required: true }],
  create(id, config) {
    return createLocalConnector(id, String(config.root));
  },
};
```

Mounting it is one line where the API is assembled:

```ts
// apps/api/src/node.ts
const app = createApp({
  local: createLocalConnector("local", driveRoot),
  documentation: createLocalConnector("documentation", documentationRoot),   // the mount this Documentation plugin reads
});
```

A new backend (say R2) means a new package implementing the same `StorageConnector` interface
— nothing in the core or the portal changes. That's the slim-core payoff: the drive doesn't
know what R2 is, and the Documentation plugin doesn't know it's reading from a folder on disk.

## Checklist

1. Write a `PluginManifest` — id, capabilities, contributions.
2. Register it (add to the installed set / `createRegistry`).
3. Build the contribution's component, reaching storage/data only through the host API.
4. Map the contribution to its component in `PLUGIN_UI` (until the runtime ships).

For a connector: implement `StorageConnector` + `StorageConnectorPlugin`, then mount it in
the API.
