# How plugins work

Canopy has **two distinct kinds of plugins**. They share the word "plugin" but almost
nothing else — different trust levels, different execution models. Keeping them separate is
a deliberate design choice.

## 1. Storage connectors — trusted, typed I/O

A connector is a thin, well-defined adapter over a storage backend. It implements
`StorageConnector` and is packaged with a factory:

```ts
interface StorageConnectorPlugin {
  readonly type: string;        // "local" | "s3" | "r2"
  readonly label: string;
  readonly configFields: ConnectorConfigField[];   // what config it needs (root, bucket, …)
  create(id: string, config: Record<string, unknown>): StorageConnector;
}
```

Connectors are trusted code that runs **in the API process** (Node today, a Worker later).
They are not sandboxed, because they _are_ the I/O boundary. `@canopy/connector-local`,
`@canopy/connector-r2`, and the read-only `@canopy/connector-github` all implement this exact
same interface.

## 2. Extension plugins — declarative, sandboxed _(server-hook sandbox planned)_

Extension plugins add UI and behaviour. A plugin is described by a **manifest** — what it
is, what it's allowed to do, and what it contributes to the host:

```ts
interface PluginManifest {
  id: string;
  name: string;
  version: string;
  icon?: string;
  color?: string;
  capabilities: Capability[];     // what the host will grant — nothing is ambient
  serverHooks?: ServerHook[];     // "enrichItem" | "transformUpload"  (planned)
  contributes?: Contributions;    // declarative UI surface
}
```

### Contribution points

A plugin doesn't reach into the UI; it _declares_ what it wants to add, and the host renders
those slots:

```ts
interface Contributions {
  contextMenu?: ContextMenuContribution[];  // items on a file's right-click menu
  railPanel?: RailPanelContribution;        // a panel in the right-hand rail
  detailView?: DetailViewContribution;      // a full-page view, opened from the sidebar
  detailFields?: DetailFieldContribution[]; // extra rows in the file preview
  store?: StoreListing;                     // how it appears in the plugin store
}
```

Calendar contributes a `railPanel` and a `detailView`; Tasks does the same; Documentation contributes
only a `detailView`. The sidebar, rail, context menus, and store are all built by querying
the registry — so a first-party plugin and a third-party one light up the same surfaces the
same way.

### The capability model

Capabilities are how a plugin earns access. It declares what it needs; the host grants only
that, as a scoped object — never ambient globals:

```ts
type Capability =
  | { kind: "item:read" }
  | { kind: "item:write" }
  | { kind: "index:query" }
  | { kind: "storage:read"; connectors?: string[] }  // e.g. just the "documentation" mount
  | { kind: "net:fetch"; hosts: string[] }           // outbound only to these hosts
  | { kind: "kv" };
```

The Documentation plugin, for example, declares `{ kind: "storage:read", connectors: ["documentation"] }`.

> **Status:** capabilities are declared and recorded today, but **not yet enforced** — there
> is no broker handing out scoped objects, because there is no sandbox yet. Enforcement
> arrives with the runtime below.

### The runtime — a switchable sandbox _(planned)_

Untrusted plugin code is meant to run inside a `PluginRuntime`, which is itself an adapter so
the sandbox can differ per deployment:

- `cf-loader` — Cloudflare's Dynamic Worker Loader. Each plugin loads into its own isolate;
  the `env` bindings you pass _are_ the granted capabilities, and `globalOutbound` enforces
  `net:fetch`.
- `node` — `isolated-vm` for local/dev/Docker.
- `cf-wfp` — Workers for Platforms, for a large multi-tenant plugin marketplace later.

The capability **broker** (deciding what a plugin gets) is runtime-agnostic; only the
_injection_ differs per adapter. The `PluginRuntime` interface lives in core today; the
adapters are not built yet.

> The **client-UI** sandbox already exists, though: file **viewers** run untrusted plugin
> code in an opaque-origin `<iframe sandbox="allow-scripts">` and receive only the previewed
> file. That's the client-side counterpart to the server-hook runtime above — see
> [Writing a plugin → File viewers](04-writing-a-plugin.md).

## How first-party plugins run *right now*

Until the sandbox lands, Calendar, Tasks, and Documentation ship as **first-party, in-process**
plugins. The split is:

- **Declarative half** — each plugin's `PluginManifest` is registered in the
  `PluginRegistry`. The host reads the registry to build the sidebar, rail tabs, context
  menus, and store. This is exactly what a sandboxed plugin will do too.
- **Render half** — because there's no sandbox to ship React into yet, the portal keeps a
  `PLUGIN_UI` map from plugin id to its React components (`RailPanel`, `DetailView`).

```ts
// apps/portal/src/plugins/index.tsx
export const PLUGIN_UI: Record<string, PluginUI> = {
  documentation: { DetailView: DocumentationView },
  calendar:      { RailPanel: CalendarPanel, DetailView: CalendarWeekView },
  tasks:         { RailPanel: TasksPanel, DetailView: TasksKanban },
};
```

When the runtime lands, the manifest/registry/contribution half stays exactly the same — only
the render-and-execute half moves from this map into the sandbox. Getting that boundary right
now is the point.

See [Writing a plugin](writing-a-plugin) for the worked example.
