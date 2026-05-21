# Writing a plugin

The page you're reading is rendered by a plugin. The **Docs plugin** is a good first example
because it touches both halves of the system: it declares a storage capability and it
contributes a UI view. We'll build it up step by step — every snippet below is the real code.

> While the dynamic runtime is still planned, plugins are wired in as first-party modules. The
> manifest, capability, and contribution parts are exactly what a sandboxed plugin will use;
> only the "ship the React" step changes later.

## 1. Declare the manifest

A plugin starts as a `PluginManifest`. The Docs plugin asks for read access to one storage
mount and says it contributes a full-page detail view:

```ts
// apps/portal/src/plugins/manifests.ts
const docs: PluginManifest = {
  id: "docs",
  name: "Docs",
  version: "0.1.0",
  icon: "book",
  color: "212 70% 48%",
  capabilities: [{ kind: "storage:read", connectors: ["docs"] }],
  contributes: {
    detailView: { id: "docs-detail", title: "Docs" },
  },
};
```

That's the entire declarative surface. The host now knows Docs exists, what it's allowed to
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

Docs is in `DEFAULT_INSTALLED`, so it's registered at startup and shows up in the sidebar
under "Plugins".

## 3. Build the view, using only granted access

The plugin's job is to read markdown from the `docs` mount and render it. It reaches storage
through the host API — the same `?mount=docs` it declared a capability for — never directly:

```tsx
// apps/portal/src/plugins/docs-view.tsx (trimmed)
export function DocsView() {
  const [docs, setDocs] = useState<FileItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");

  useEffect(() => {
    listFiles("", "docs").then((items) => {           // GET /api/files?mount=docs
      const md = items.filter((f) => /\.md$/i.test(f.name));
      setDocs(md);
      setSelected((s) => s ?? md[0]?.path ?? null);
    });
  }, []);

  useEffect(() => {
    if (selected) readText(selected, "docs").then(setContent);   // GET /api/file?mount=docs
  }, [selected]);

  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>;
}
```

The data path end to end:

```
DocsView ─ listFiles("", "docs") ─► GET /api/files?mount=docs
                                       └─ @canopy/api picks the "docs" connector
                                            └─ @canopy/connector-local reads ./docs
```

## 4. Connect the view to the contribution

The manifest said "I have a detail view." The portal needs to know _which component_ that is.
Until the sandbox can ship plugin code, that mapping lives in `PLUGIN_UI`:

```ts
// apps/portal/src/plugins/index.tsx
export const PLUGIN_UI: Record<string, PluginUI> = {
  docs: { DetailView: DocsView },
  // …
};
```

When you open Docs from the sidebar, the host looks up `PLUGIN_UI["docs"].DetailView` and
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
`examples/plugins/pdf-viewer` for a PDF showcase that uses the browser's native engine — no
external libraries, fully offline.

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
  docs:  createLocalConnector("docs", docsRoot),   // the mount this Docs plugin reads
});
```

A new backend (say R2) means a new package implementing the same `StorageConnector` interface
— nothing in the core or the portal changes. That's the slim-core payoff: the drive doesn't
know what R2 is, and the Docs plugin doesn't know it's reading from a folder on disk.

## Checklist

1. Write a `PluginManifest` — id, capabilities, contributions.
2. Register it (add to the installed set / `createRegistry`).
3. Build the contribution's component, reaching storage/data only through the host API.
4. Map the contribution to its component in `PLUGIN_UI` (until the runtime ships).

For a connector: implement `StorageConnector` + `StorageConnectorPlugin`, then mount it in
the API.
