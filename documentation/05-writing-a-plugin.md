# Writing a plugin

The page you're reading is rendered by a plugin. The **Documentation plugin** is a good first example
because it touches both halves of the system: it declares a storage capability and it
contributes a UI view. We'll build it up step by step — every snippet below is the real code.

> Documentation is a **first-party, trusted** plugin: its view is a React component compiled
> into the host. That's the privileged tier. An *untrusted* plugin contributes the same rail
> panels and detail views **sandboxed**, as a vanilla `render(ctx)` in an opaque-origin iframe —
> see [Sandboxed UI slots](#sandboxed-ui-slots-rail-panels-and-detail-views) below. The manifest,
> capability, and contribution parts are identical across both tiers; only how the UI is rendered
> and what it can touch differ.

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
under "Plugins". Which plugins a user has installed is [persisted per user](how-plugins-work) — and
a space **owner** can additionally [apply a plugin to a place](how-plugins-work), turning it on for
every member; the registry renders the union of the two.

## 3. Build the view, using only granted access

The plugin's job is to read markdown from the `documentation` mount and render it. It reaches storage
through the host — `usePluginHost()` from `@canopy/plugin-sdk`, the same `documentation` mount it declared
a capability for — never directly via `@/lib/api`:

```tsx
// apps/portal/src/plugins/documentation-view.tsx (trimmed)
import { usePluginHost, type PluginFile } from "@canopy/plugin-sdk";

export function DocumentationView() {
  const host = usePluginHost();
  const [docs, setDocs] = useState<PluginFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");

  useEffect(() => {
    host.listMount("", "documentation").then((items) => {  // GET /api/files?mount=documentation
      const md = items.filter((f) => /\.md$/i.test(f.name));
      setDocs(md);
      setSelected((s) => s ?? md[0]?.path ?? null);
    });
  }, [host]);

  useEffect(() => {
    if (selected) host.readMountText(selected, "documentation").then(setContent);   // GET /api/file?mount=documentation
  }, [selected, host]);

  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>;
}
```

The data path end to end:

```
DocumentationView ─ host.listMount("", "documentation") ─► GET /api/files?mount=documentation
                                       └─ @canopy/api picks the "documentation" connector
                                            └─ @canopy/connector-local reads ./documentation
```

## 4. Connect the view to the contribution

The manifest said "I have a detail view." The portal needs to know _which component_ that is.
Because Documentation is first-party and trusted, that mapping lives in `PLUGIN_UI` — the
compiled-in React tier (an untrusted plugin would render its detail view sandboxed instead; see
[below](#sandboxed-ui-slots-rail-panels-and-detail-views)):

```ts
// apps/portal/src/plugins/index.tsx
export const PLUGIN_UI: Record<string, PluginUI> = {
  documentation: { DetailView: DocumentationView },
  // …
};
```

When you open Documentation from the sidebar, the host looks up `PLUGIN_UI["documentation"].DetailView` and
renders it in the content area. That's the whole plugin.

> **Stay on the boundary.** Even a trusted React view should reach the host through the
> `@canopy/plugin-sdk` contract — `usePluginHost()` for file/AI capabilities, `usePluginTheme()`
> for light/dark — and import UI from `@canopy/ui` (shadcn primitives, `Icon`, `cn`, `toast`),
> rather than reaching into `@/lib/api`, `@/plugins/host`, or `@/components/ui/*`. The Model Editor
> is the reference, with a lint rule enforcing the boundary on `src/components/model-editor/**`.
> Keeping a view on the SDK is what makes it swappable to a sandboxed runtime — or another host
> entirely — by reimplementing the bridge, not the view. The Model Editor does exactly this today:
> the same `@canopy/model-editor` component tree runs in the Canopy portal, as a
> [VS Code extension](plugin-model-editor) (`apps/vscode-model-editor`, bridge over webview
> `postMessage`), and as a backend-free [standalone web app](plugin-model-editor)
> (`apps/model-editor-demo`, bridge over the File System Access API) — three hosts, one view, three
> `HostBridge` implementations.

## A data-source plugin (GitHub)

The Documentation plugin reads bytes; the **GitHub** plugin feeds _typed records_ into the
Tasks and Calendar plugins. It's the worked example of a [data source](how-plugins-work). Its
manifest declares a `dataSource` contribution plus the one host it may reach:

```ts
// apps/portal/src/plugins/manifests.ts (shape)
{
  id: "github",
  name: "GitHub",
  capabilities: [{ kind: "net:fetch", hosts: ["api.github.com"] }],
  contributes: { dataSource: { provides: ["tasks", "calendar"] } },
}
```

The trusted half lives server-side: a `ServerDataSource` that declares its config schema and
builds normalized providers, wrapping each upstream call in the **scoped cache** it's handed:

```ts
// apps/api/src/data-sources.ts (trimmed)
export const githubDataSource: ServerDataSource = {
  id: "github",
  configFields: [
    { key: "repo",   label: "Repository (owner/repo or URL)", type: "url", required: true },
    { key: "branch", label: "Branch (default: main)",         type: "string" },
    { key: "token",  label: "Token — only for private repos", type: "secret" },
  ],
  build(config, ctx) {
    const cfg = parseRepo(config.repo);                     // owner/repo
    const tasks = createGithubTaskProvider("github", cfg);  // issues → Task[]
    return {
      tasks: { id: "github", listTasks: () =>
        ctx?.cache ? ctx.cache.wrap(`tasks:${cfg.owner}/${cfg.repo}`, 5*60_000, () => tasks.listTasks())
                   : tasks.listTasks() },
      // calendar: milestones + releases → CalendarEvent[]
    };
  },
};
```

That's the whole contract: **declare** `configFields` + a `dataSource`, **implement** the
provider, and **cache** through the store you're given. Everything else is the host's:

- the portal renders the settings form from `configFields` and saves it per-user via
  `PUT /api/plugins/github/settings` (the `token` is encrypted, never read back);
- `GET /api/tasks` / `GET /api/calendar` resolve the caller's config (or the demo default),
  build the providers with a `(plugin, user)`-scoped cache, and return normalized JSON;
- the Tasks and Calendar plugins call those endpoints — they never mention GitHub.

## A server-side processor (Document AI)

A **processor** acts on a file when it changes instead of contributing UI. The **Document AI**
plugin labels and describes each added document. It declares its config and a `process`
function — that's the whole plugin:

```ts
// apps/api/src/processors.ts (trimmed)
export const documentAiProcessor: DocumentProcessor = {
  id: "document-ai",
  configFields: [
    { key: "model",    label: "Model",                              type: "select", optionsFrom: "ai-models" },
    { key: "language", label: "Output language (default: English)", type: "string" },
  ],
  // Eligible wherever the host has a model — no per-user key needed.
  eligible: (_config, ctx) => !!ctx.ai && ctx.ai.models().length > 0,
  async process(file, config, ctx) {
    const model = config.model || ctx.ai!.models()[0]?.id;             // the user's pick, else the first
    const out = await ctx.ai!.generate({ model, messages: analyze(file), json: true });
    const { label, description } = parse(out.text);
    return { labels: label ? [label] : [], description, model: out.model };  // merged into metadata
  },
};
```

The processor never holds a key: it asks the host's **AI gateway** (`ctx.ai`) for a model and a
completion, so it runs unchanged on Cloudflare Workers AI, Gemini, or a local model. The user
picks *which* model — the `model` field is a `select` the host fills from `GET /api/ai/models` —
and an output language; provider keys live under **Settings → AI**, not in this plugin. See
[the processor role](how-plugins-work) for the gateway.

The host owns everything around it: on `POST /api/files` it reads the new file's bytes once,
runs each eligible processor **off the response path** (`ctx.waitUntil` on Cloudflare, a
background promise on Node), and writes the merged `labels` + `description` back with a metadata
patch — a metadata edit, so **no new version**.

```
upload ─► POST /api/files ─► createFile ─┐                       (response returns immediately)
                                          └─ waitUntil: read bytes ─► ctx.ai.generate ─► metadata
```

Like data sources, this runs trusted and first-party today; it's the exact shape the sandboxed
`enrichItem` / `transformUpload` hook will take once the runtime lands. The label and description
then show in the file's preview details.

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

## Sandboxed UI slots (rail panels and detail views)

A viewer renders a *file*. A **UI slot** renders a *plugin surface* — the right-rail panel or the
full-page detail view. First-party plugins like Documentation render these as trusted React in
`PLUGIN_UI`; an **untrusted** plugin renders the very same slots in the same opaque-origin
`<iframe sandbox="allow-scripts">` a viewer uses. The difference from a viewer: a slot isn't handed
a file. It's handed *nothing* ambient, and asks the host for data through a **capability bridge**.

The entry module exports one `render` per slot it contributes — a named export matching the
contribution. No React; vanilla DOM, styled with the host theme tokens (`hsl(var(--primary))`,
`--card`, `--border`, …) which the host mirrors into the frame so the slot looks native:

```js
// examples/plugins/calendar/index.js
export async function detailView(ctx) {
  // ctx.call(method, params) → the capability bridge (host fulfils it, with its credentials)
  // ctx.container = the element to render into
  const { events, source } = await ctx.call("calendar.list");
  for (const ev of events) ctx.container.appendChild(renderEvent(ev));
}

export async function railPanel(ctx) {
  const { events } = await ctx.call("calendar.list");
  // …render the compact "Up next" list…
}
```

`ctx.call` is the client-side counterpart to the server-hook `CapabilityGrants`: the plugin can
only invoke methods the host wired up for it — that map **is** the grant. The host does the
privileged work (here, the credentialed `GET /api/calendar`, with a sample-data fallback) and posts
the result back. No `fetch`, no cookies, no host DOM ever cross into the frame.

Register it like a viewer — by id and source — and declare the contributions in the manifest:

```ts
// apps/portal/src/plugins/ui.ts
export const UI_PLUGINS: SandboxedUIPlugin[] = [
  { id: "calendar", source: calendarSource, slots: ["detailView", "railPanel"] },
];
```

```json
// examples/plugins/calendar/canopy.json
{
  "id": "calendar",
  "contributes": {
    "railPanel":  { "id": "calendar-rail",   "title": "Calendar", "icon": "calendar" },
    "detailView": { "id": "calendar-detail", "title": "Calendar" }
  }
}
```

At each render site the host calls `sandboxedSlot(id, slot)` and, if it matches, mounts
`<PluginSlot>` instead of looking up `PLUGIN_UI` — so a sandboxed plugin and a first-party one light
up the same rail tab and sidebar entry. The bridge (host ↔ iframe `postMessage`: id-correlated RPC
for `ctx.call`, plus theme injection and auto-resize) lives in
`apps/portal/src/components/plugin-slot.tsx`. **Calendar is the reference implementation** — it was
a `PLUGIN_UI` React component and now runs entirely in the sandbox.

> **Capability gap (today):** `ctx.call` is gated by the method map the host injects, so a plugin
> can't call what wasn't granted. But there's no *declarative* `Capability` kind yet for "consume a
> host data source" (the way `storage:read` declares a mount), so the calendar example manifest
> lists `capabilities: []`. A `data:*` kind is the natural follow-up.

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

Mounting it is a few lines where the API is assembled — read-only mounts (like the
Documentation plugin's) go in `readonlyMounts`, keyed by name:

```ts
// apps/api/src/node.ts
const app = createApp({
  drive: { service, blobs },                                  // the managed drive (@canopy/store)
  readonlyMounts: {
    documentation: createLocalConnector("documentation", documentationRoot),  // the mount the Documentation plugin reads
    demo:          createLocalConnector("demo", demoRoot),
  },
});
```

A new backend (say R2) means a new package implementing the same `StorageConnector` interface
— nothing in the core or the portal changes. That's the slim-core payoff: the drive doesn't
know what R2 is, and the Documentation plugin doesn't know it's reading from a folder on disk.

## Checklist

1. Write a `PluginManifest` — id, capabilities, contributions.
2. Register it (add to the installed set / `createRegistry`).
3. Build the contribution, reaching storage/data only through the host API or `ctx.call`.
4. Wire the contribution to its renderer:
   - **Sandboxed** (untrusted, the third-party path) — export `render(ctx)` per slot and
     register the source in `viewers.ts` (file viewer) or `ui.ts` (rail / detail slot).
   - **First-party trusted** — map the contribution to its React component in `PLUGIN_UI`.

For a connector: implement `StorageConnector` + `StorageConnectorPlugin`, then mount it in
the API.
