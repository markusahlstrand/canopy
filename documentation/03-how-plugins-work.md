# How plugins work

A **plugin** is one thing: a package with an identity, a manifest, and a set of declared
capabilities. What varies is the **roles** a plugin fills — and a single plugin can fill
several at once. Each role runs in the **execution context its trust level demands**:

- **Trusted, in-process roles** run inside the API and _are_ the I/O boundary, so they aren't
  sandboxed — **storage connectors** (raw bytes), **data sources** (typed records like tasks
  or calendar events), and **processors** (derive something when a file changes, e.g. an AI
  label).
- **Sandboxed roles** run untrusted code in isolation and only ever touch what the host
  explicitly grants — **file viewers** and **UI slots** (rail panels / detail views), both in
  the client-side iframe sandbox shipping today, and server-hook **extensions** (the
  `PluginRuntime` sandbox, planned).
- **Declarative UI roles** contribute surfaces the host renders — rail panels, detail views,
  context-menu items, and file-type creators. A *first-party, trusted* plugin renders these as
  React compiled into the host; an *untrusted* one renders the same slots sandboxed (see below).

So "connector", "data source", and "viewer" aren't separate _kinds of plugin_ that happen to
share a word — they're **roles one plugin can combine**. They share everything that makes a
plugin a plugin (identity, manifest, declared capabilities, configuration and secrets,
lifecycle); what differs is only _where each role runs_. The GitHub integration is already a
single install playing two roles — a manifest declaring a `dataSource` contribution plus the
server-side source that feeds it — and could add a connector, a processor, or a viewer to the
same package without becoming a different "kind" of thing. (A "Google Drive" plugin would
plausibly be all of these at once: one install, one credential.)

The rule holds for every role: a plugin **declares** what it is and what it needs, the host
grants only that as a **narrow, scoped API** — never ambient access — and runs each role in the
context its trust level requires. Trust attaches to the **role**, not the package: an operator
vets the in-process roles (they run with real privilege), while the sandboxed roles light up
freely. The rest of this page is that contract, role by role.

## 1. The storage-connector role — trusted, typed I/O (bytes)

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
`@canopy/connector-r2`, `@canopy/connector-synology`, and the read-only
`@canopy/connector-github` all implement this exact same interface.

### What a connector can do

A connector advertises its abilities **structurally** — by which methods it implements. The
host feature-detects each optional method and lights up (or hides) the matching affordance;
nothing is keyed off a connector's id or type in the UI. The surface:

| Ability | Member | Required | Notes |
|---|---|---|---|
| Browse | `list(path, opts?)` | ✅ | Paginated (`cursor`/`limit`) listing of a folder. |
| Stat | `stat(path)` | ✅ | One entry's metadata, or `null` if it's gone. |
| Read bytes | `read(path)` | ✅ | Streams the file. The bucket is the source of truth. |
| Write bytes | `write(path, body)` | ✅ | A read-only backend (GitHub today) throws here; that's what makes its space read-only. |
| Delete | `remove(path)` | ✅ | — |
| Make folder | `mkdir?(path)` | optional | Real directory backends (NAS, filesystem) implement it; flat key stores (R2) omit it — folders there are implicit prefixes. |
| Direct transfer | `signedUrl?(path, op, ttl?)` | optional | Presigned URL so the client streams bytes straight from the backend, bypassing the API. |
| Change feed | `changes?(cursor?)` | optional | Incremental sync. Connectors that can't emit changes (plain R2) omit it; the host falls back to crawl + lazy reconcile on read. |
| Branches | `branch` + `branches?` | optional | A connector rooted at a versioned ref (GitHub). See below. |

Whether a connector's space is **writable** is therefore not a flag it sets — it's whether
`write`/`remove` succeed. A separate `writable: true` on the _source plugin_ (data-source
registration) is what tells the host to *route* folder-creates and uploads through the
connector at all; see [Storage & files](07-storage-and-files.md).

#### Branches — a versioned connector

A backend with a branch concept (today: GitHub) sets `readonly branch` to the ref it's rooted
at and exposes `BranchOps`:

```ts
interface BranchOps {
  list(): Promise<BranchInfo[]>;          // every ref, with default/current/protected + tip sha
  create(name: string, from?: string): Promise<void>;
  remove(name: string): Promise<void>;
}
```

The connector instance is rooted at **one** branch; `list()` reports the rest. Switching is a
**config change the host persists** (the per-user `branch` setting) and then **re-indexes**
against — not a connector method. `create`/`remove` are real writes against the backend and
need a token with write access; their errors bubble up verbatim. A connector with no branch
concept (a NAS, R2) omits all of this and the host shows no branch UI.

The active branch is **URL state** (`?space=connector:<plugin>&path=…&branch=<ref>`), so a
switch updates the address bar and the link is shareable/bookmarkable; opening a `branch=` link
selects (and, if it differs from the persisted ref, switches to) that branch. The host writes
the param only for connector spaces.

> **Known wart — the branch picker is hardcoded host chrome.** The topbar renders a GitHub
> `BranchPicker` gated on the current space being a connector space; there is no _topbar slot_
> contribution today (see [Contribution points](#contribution-points) — `railPanel` and
> `detailView` exist, a topbar/space-controls slot does not). The right shape is a generic
> "space control" extension point that a connector with `BranchOps` populates with a ref
> picker, composed into the URL by the host — so the connector capability drives the UI instead
> of the UI special-casing the connector. Until that lands, treat the picker as a host-side
> rendering of the `BranchOps` capability, not a GitHub-specific feature.

## 2. The data-source role — trusted, typed records

Where a connector serves _bytes_, a **data source** serves _typed records_ into a host plugin:
GitHub issues into **Tasks**, milestones and releases into **Calendar**. Like a connector it's
trusted code in the API (it holds tokens and calls third-party APIs), and it normalizes some
external system into a host-defined shape, so the UI never learns where the data came from:

```ts
interface TaskProvider     { listTasks(): Promise<Task[]>; }
interface CalendarProvider { listEvents(range: CalendarRange): Promise<CalendarEvent[]>; }
```

A source plugin declares which surfaces it feeds (a `dataSource` contribution, below) and what
config it needs; the host registers a factory that builds the providers from a saved config:

```ts
interface ServerDataSource {
  id: string;                              // "github"
  configFields: ConnectorConfigField[];    // repo (required), branch, token (secret)
  build(config, ctx?: { cache?: CacheStore }): { tasks?: TaskProvider; calendar?: CalendarProvider };
}
```

The host exposes the normalized data over stable endpoints the Tasks/Calendar plugins call —
`GET /api/tasks`, `GET /api/calendar` — and reports what's connected via `GET /api/integrations`.
Config is **per-user** (see _Configuration & settings_ below); when a user hasn't connected
their own source the host falls back to a public **demo default**, so the logged-out demo still
has data.

`build` is handed a **cache scoped to that plugin + user**, and the adapter owns its own TTL —
GitHub caches for 5 minutes to stay under the API rate limit. That cache is a swappable
`CacheStore` (see _A shared, swappable cache_ below), so a source caches identically on Node and
Cloudflare.

## 3. The processor role — trusted, runs on change

A **processor** acts on a file when it changes and derives something from it. The built-in
**Document AI** plugin is the example: when a file is added it asks the host's AI model for a
short **type label** (e.g. *Invoice*, *Receipt*, *Contract*) and a one-line **description**, and
merges both into the file's metadata. Like a connector or data source it's trusted code in the
API:

```ts
interface DocumentProcessor {
  id: string;
  configFields: ConnectorConfigField[];
  /** Should this run for the given config + host context? Default: required config present. */
  eligible?(config, ctx: ProcessorContext): boolean;
  /** Returns labels + an optional description to merge into the file's metadata. */
  process(file, config, ctx: ProcessorContext): Promise<ProcessorResult>;
}
// ProcessorResult = { labels: string[]; description?: string; model?: string; error?: string }
```

The host runs it on `POST /api/files` **off the response path** — `ctx.waitUntil` on a Worker, a
background promise on Node — so it never slows an upload. It reads the new file's bytes once,
calls each **eligible** processor, and merges the result back with a metadata patch (a metadata
edit, so **no new version**), recording each run in `metadata.processing`. Failures are swallowed
— labeling must never break an upload. It currently fires on **new uploads only**.

This is the **trusted, first-party form** of the planned `enrichItem` / `transformUpload`
sandbox hooks (below): the same shape and the same `metadata` write — only _where the code runs_
changes when the sandbox lands.

### The host AI gateway

Inference isn't the processor's concern. It asks the host's **AI gateway** (handed in as
`ctx.ai`) for a model and a completion, so the same processor runs unchanged on Cloudflare
Workers AI, Google Gemini, or a local / OpenAI-compatible model:

```ts
interface AiGateway {
  models(): AiModel[];                                  // the union of every configured provider
  generate(req: AiGenerateRequest): Promise<AiGenerateResult>;
}
```

- **Per deployment**, the host composes providers: Workers AI (the `AI` binding) on Cloudflare —
  so Document AI labels uploads **with no key, out of the box** — or `GOOGLE_AI_API_KEY` /
  `OPENAI_BASE_URL` on Node.
- **Per user**, a signed-in user can add their own Gemini or OpenAI-compatible provider under
  **Settings → AI** (keys encrypted at rest); those layer on top of the deployment's for that
  caller only.
- The portal lists the caller's available models at `GET /api/ai/models`. That's how Document
  AI's `model` field gets its choices — it's a `select` with `optionsFrom: "ai-models"`, which
  the host fills in when it serves the settings form. So the user just picks a model and an
  output **language**; there's no per-plugin API key.
- The same gateway is reachable from trusted host UI at `POST /api/ai/generate` (the `ai:generate`
  surface). The **Plugin Studio** uses it to have the model author a new plugin — see
  [Build a plugin with AI](build-a-plugin-with-ai). Sandboxed plugins don't reach this endpoint.

Because the gateway is an interface, "which model" is a deployment / user choice, not a code
change — the same swap-the-adapter pattern as storage and the cache.

## 4. The manifest — every plugin's declaration

The roles above are trusted, in-process code. The remaining roles — **UI surfaces**, **file
viewers**, and **server hooks** — are declared, not handed privileged factories, and the
viewer/hook roles run sandboxed. But the **manifest** that carries all of this isn't special to
them: _every_ plugin has one, whatever roles it fills. It declares what the plugin is, what
it's allowed to do, and what it contributes to the host:

```ts
interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;           // catalog / store copy
  icon?: string;
  color?: string;
  entry?: string;                 // entry module, for plugins that ship sandboxed code
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
  viewers?: ViewerContribution[];           // sandboxed file-type viewers (see writing-a-plugin)
  creators?: FileCreatorContribution[];     // "New …" entries — file types this plugin creates
  dataSource?: DataSourceContribution;      // declares typed providers (tasks / calendar)
  store?: StoreListing;                     // how it appears in the plugin store
}
```

Calendar contributes a `railPanel` and a `detailView`; Tasks and Documentation each contribute a
`detailView` (Tasks adds a context-menu item too); GitHub contributes a `detailView` and a
`dataSource`. The sidebar, rail, context menus, and store are all built by querying the registry
— so a first-party plugin and a third-party one light up the same surfaces the same way.

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
  | { kind: "kv" }
  | { kind: "ai:generate"; models?: string[] };      // inference via the host AI gateway
```

The Documentation plugin, for example, declares `{ kind: "storage:read", connectors: ["documentation"] }`.

`ai:generate` lets a plugin run inference through the host AI gateway without ever holding a
provider key (the host routes by model id; see [the gateway below](#the-host-ai-gateway)). Today
it's reached only by trusted, first-party host UI — the **Plugin Studio** uses it via
`POST /api/ai/generate` to author new plugins. The grant for *sandboxed* plugins is reserved but
not yet wired, so a generated viewer can't call it; it's the manifest a future server-hook sandbox
will honor.

### What a plugin receives — `CapabilityGrants`

Declaring a capability is one half; the other is what the host hands back. A **broker** turns
declared capabilities into a single `grants` object of scoped host functions — this is the
**entire API surface** a sandboxed plugin can call. No ambient globals, no bare `fetch`, no DOM:

```ts
interface CapabilityGrants {
  fetch?:      (input: string, init?: RequestInit) => Promise<Response>;   // net:fetch — granted hosts only
  getItem?:    (id: string) => Promise<unknown>;                           // item:read
  queryIndex?: (query: SearchQuery) => Promise<Page<SearchHit>>;           // index:query
  kv?: { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> }; // kv
}
```

The `kv` grant is backed by the shared cache layer (next section), **namespaced per plugin +
user** so one plugin can't read another's — or another user's — keys. The runtime injects the
whole object differently per adapter: as Worker `env` bindings + `globalOutbound` under
`cf-loader`, as the restricted context object under `node`. The broker
(`grantsForManifest(manifest, { cache, userSub })`) is runtime-agnostic; only the injection differs.

> **Status:** the `kv` grant and the broker exist today; `fetch` / `getItem` / `queryIndex` are
> declared and recorded but **not yet enforced**, because the server-hook sandbox that would
> inject them isn't built yet. Enforcement arrives with the runtime below. (The `SearchIndex` that
> `queryIndex` will query is already built — interface + a SQLite/D1 FTS adapter; and the trusted
> GitHub data source already uses the same scoped cache directly.)

## A shared, swappable cache (`CacheStore`)

External calls are memoized through a small interface so every backend looks the same to the
code (and to plugins via `kv`):

```ts
interface CacheStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
  wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T>;   // get-or-compute
}
```

Two backends ship: `createSqlCacheStore(db)` (the `kv_cache` table — works on libsql locally and
D1 on Cloudflare) and `createCacheApiCacheStore()` (Cloudflare's `caches.default`, chosen on the
Worker). `scopedCache(base, prefix)` wraps any store to prefix every key — the mechanism behind
the per-plugin / per-user isolation above. Because the interface is the boundary, the GitHub
source caches for 5 minutes identically on Node and the edge.

## The runtime — a switchable sandbox _(planned)_

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

> The **client-UI** sandbox already exists, though, and now covers **UI slots** too, not just
> file viewers. Untrusted plugin code — a file viewer, a rail panel, or a detail view — runs in
> an opaque-origin `<iframe sandbox="allow-scripts">` and exports a vanilla `render(ctx)`. A
> viewer receives only the previewed file; a UI slot receives nothing ambient and reaches host
> data through a narrow **capability bridge** (`ctx.call(method, params)`) the host fulfils with
> its own credentials — the client-side counterpart to the server-hook `CapabilityGrants` above.
> That map of methods *is* the grant. See
> [Writing a plugin → Sandboxed UI slots](05-writing-a-plugin.md) and
> [→ File viewers](05-writing-a-plugin.md).

## Combining roles: one package, one registration

Because trust attaches to the **role**, a single plugin can fill several at once — and that's
often the natural unit. A "Google Drive" plugin would plausibly be a **connector** (browse
Drive as storage), a **data source** (recent and shared activity into the feed), a **processor**
(OCR on upload), and a **viewer** — one install, one OAuth credential. Splitting that into four
separate "plugins" would fracture the shared auth and config for no benefit.

Each role keeps its own contract — they're distinct on purpose, not duplicated:

| Role | Contract | Trust / where it runs |
|---|---|---|
| Storage connector | `StorageConnectorPlugin` — `create()` → `StorageConnector` | trusted, in-process |
| Data source | `ServerDataSource` — `build()` → providers | trusted, in-process |
| Processor | `DocumentProcessor` — `process()` → labels + description | trusted, in-process |
| File viewer | `contributes.viewers` (an entry module) | sandboxed (client iframe) |
| Server hook | `serverHooks` (`enrichItem` / `transformUpload`) | sandboxed (planned) |
| UI slot (rail · detail) | `contributes.railPanel` / `detailView` (an entry module) | sandboxed (client iframe), or trusted first-party React (`PLUGIN_UI`) |
| UI surface | `contributes.*` (context menu · creators) | declarative |

**The target shape.** A plugin is one package whose manifest declares every role it fills, and a
single host call registers all of them — fanning each role into the subsystem that runs it at
its trust level:

```ts
// the role contracts all live in @canopy/core; a server plugin bundles a
// manifest with the trusted, in-process roles it provides
interface ServerPlugin {
  manifest: PluginManifest;              // identity + capabilities + contributions
  connectors?: StorageConnectorPlugin[];
  dataSource?: ServerDataSource;
  processors?: DocumentProcessor[];
}

installPlugin(host, plugin);             // one front door — registers the manifest + every role
```

**Where this stands today.** The role **contracts** all live in `@canopy/core` now —
`StorageConnectorPlugin`, `ServerDataSource`, `DocumentProcessor`, and the task/calendar
providers — next to a `ServerPlugin` type that bundles them. The API registers its first-party
plugins through **one list** (`SERVER_PLUGINS` in `apps/api/src/plugins.ts`), where each entry
declares the roles it fills, and fans them into the subsystems that run them. What's left: the
**manifest** (the UI-facing declaration) still lives client-side in the portal, so a server
plugin is keyed by `id` rather than carrying its own manifest. Converging those into one source
of truth per plugin — plus adding the `connector` role to the bundle and a single
`installPlugin()` front door — is the remaining step. None of it changes the per-role contracts
above or their trust boundaries.

## Configuration & settings

A plugin that needs configuration — a data source's repo and token, say — declares
`configFields` (the same `ConnectorConfigField[]` a connector uses). That schema is
**server-authoritative**: the portal renders a generic settings form from it, so there's no
plugin-specific settings UI to write. Values are saved **per user** via
`GET`/`PUT /api/plugins/:id/settings`.

Secret fields (`type: "secret"`, e.g. a token) get special handling:

- **encrypted at rest** — AES-GCM, keyed by the server's `SESSION_SECRET`, before they touch
  the database;
- **never returned to the client** — the settings response reports only whether each secret is
  _set_, not its value. A token round-trips through the form once and is never readable from the
  browser again.

That's why a public repo needs no token at all, while a private one takes a token that stays
server-side. The same `(plugin, user)` scoping flows into the cache, so one user's private data
is never served to another.

## How UI plugins run: two tiers

Every plugin registers its `PluginManifest` in the `PluginRegistry`, and the host reads the
registry to build the sidebar, rail tabs, context menus, and store. That **declarative half** is
identical for everyone. What differs is the **render half** — and there are now two tiers:

- **Trusted, first-party (compiled-in React).** Tasks, Documentation, GitHub, Document AI, and the
  Model Editor ship as React components the host compiles into its own bundle, mapped by plugin id
  in `PLUGIN_UI`. They run *as* host code — a privileged tier, not the third-party contract.

  ```ts
  // apps/portal/src/plugins/index.tsx — the trusted first-party tier
  export const PLUGIN_UI: Record<string, PluginUI> = {
    documentation:  { DetailView: DocumentationView },
    tasks:          { DetailView: TasksView },
    github:         { DetailView: GithubView },
    "document-ai":  { DetailView: DocumentAiView },
    "model-editor": { FileView: ModelEditorFileView },
  };
  ```

  Privileged does **not** mean unbounded. **All** trusted views reach the host through a defined
  contract instead of importing app internals directly:

  - **`@canopy/plugin-sdk`** — the capability bridge. A view calls `usePluginHost()` to get a
    `HostBridge` and `usePluginTheme()` for light/dark, instead of importing `@/lib/api` or wiring
    its own `.dark` observer. The app implements the bridge once
    (`apps/portal/src/plugins/host-bridge.ts`) and provides it via `<PluginHostProvider>`. Swapping
    that one implementation is what lets the same view run in a different host — and the
    [Model Editor](plugin-model-editor) already does: its `@canopy/model-editor` view runs unchanged
    in the portal, in a [VS Code extension](plugin-model-editor) (bridge over webview `postMessage`),
    and in a backend-free [standalone app](plugin-model-editor) (bridge over the File System Access
    API). Same view, three hosts, three bridges — the portability the SDK boundary buys, shipped. The
    SDK also ships the generic, schema-driven `PluginSettingsDialog` (it reaches
    settings I/O through the bridge, so any plugin can offer settings).
  - **`@canopy/ui`** — the shared component library. Views import shadcn primitives, the `Icon`
    set, `cn`, `toast`, and shared host components like `PersonAvatar` from `@canopy/ui` (used by
    the app too), rather than from `@/components/ui/*` or `@/lib/*`.

  **The boundary is hybrid by design.** `HostBridge` carries genuinely *generic* capabilities —
  files, AI, plugin settings, connector spaces (`listSpaces` / `syncConnector` / `testConnector`),
  and mount reading. Capabilities that are specific to one feature — the GitHub data-source
  (`getTasks` / `getCalendar` / `getIntegrations`, via the `PluginDataProvider` context) and
  Document AI's processing feed (`listProcessing`) — deliberately stay app-coupled rather than
  bloating a generic contract that only first-party code would use.

  An ESLint `no-restricted-imports` rule keeps each view on the boundary: the
  `src/components/model-editor/**` block bans app-internal imports wholesale, and the block over the
  five detail/file views bans UI paths plus the *generic* `@/lib/api` names (the ones with a
  `HostBridge` home) by name — while letting the feature-specific endpoints through. That encodes
  the hybrid line so it can't quietly rot.

- **Sandboxed (opaque-origin iframe).** An untrusted plugin renders the same rail-panel /
  detail-view slots inside the client-UI sandbox — a vanilla `render(ctx)` in an
  `<iframe sandbox="allow-scripts">`, reaching host data only through the capability bridge
  (`ctx.call`). These are registered like viewers, by id + source, in `UI_PLUGINS`
  (`apps/portal/src/plugins/ui.ts`), and mounted by `<PluginSlot>`.

**Calendar is the reference migration.** It used to live in `PLUGIN_UI` as React; it now runs in
the sandbox — same rail panel and detail view, but no React and no host access beyond a single
`calendar.list` capability. The render sites check `sandboxedSlot(id, slot)` first and fall back
to the `PLUGIN_UI` map, so the two tiers coexist. A third-party plugin only ever gets the
sandboxed tier; `PLUGIN_UI` stays the deliberately privileged seat for first-party code.

## Installing plugins (per user)

A plugin only renders for a user who has it **installed**. The install set is a list of plugin
ids, persisted server-side per user (the `plugin_installs` table — one JSON array per `user_sub`)
and read/written via `GET`/`PUT /api/plugins/installed`. `createRegistry(installedIds)` registers
just those manifests, so the sidebar, rail, context menus, and store reflect each user's own set;
installing or removing a plugin in the store writes the new set back.

With nothing saved yet the server applies an **auth-dependent default**: signed-in users start
with Calendar and Tasks (`DEFAULT_INSTALLED`), while signed-out / anonymous visitors (incl. demo
mode) also get Documentation, which doubles as the landing page (`ANON_DEFAULT_INSTALLED`). A
stored empty list (`[]` — everything uninstalled) stays distinct from "no row yet" (apply the
default).

## Applying plugins to a place (per-space)

Installs are personal; a **place** (a space — see [Sharing & spaces](08-sharing-and-spaces.md))
can also have plugins **applied** to it. A plugin applied to a group space is active for **every
member** of that space — it isn't opt-in — so the write is gated to a space **owner** (the place's
"admin"); any member may read what's applied. The mapping is the `space_plugins` table
(`(space_id, plugin_id)`), exposed as:

- `GET /api/spaces/:id/plugins` — what runs here (viewer+);
- `POST /api/spaces/:id/plugins` `{ pluginId }` / `DELETE /api/spaces/:id/plugins/:pluginId` — apply / remove (owner);
- `GET /api/plugins/:id/places` — the group spaces the caller owns, each flagged applied — powers the
  "Applies to places" picker in a plugin's settings.

A user's **effective** set — what the registry actually renders — is their own installs unioned
with every plugin applied to a space they belong to, served by `GET /api/plugins/active`. (Plugin
*config* stays per-user, encrypted; applying a plugin to a shared place turns it on, and each
member supplies their own config where a plugin needs one.)

See [Writing a plugin](writing-a-plugin) for the worked example.
