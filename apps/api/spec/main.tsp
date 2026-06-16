import "@typespec/http";
import "@typespec/openapi";
import "./models.tsp";

using TypeSpec.Http;
using TypeSpec.OpenAPI;

/**
 * Canopy — an extensible, plugin-driven portal. This contract covers the full HTTP
 * surface of the API worker: the DB-backed drive (spaces, files, versions, the
 * content-addressed upload flow, full-text search), sharing (grants, share links,
 * comments), space membership & invites, connected spaces (NAS/repo connectors,
 * branches, indexing), the offline-mirror change feed, per-user plugin settings,
 * Plugin Studio (custom plugins), AI inference, and the data-source plugins
 * (tasks/calendar).
 *
 * Endpoints are bearer-authenticated unless marked `@useAuth(NoAuth)`; a few work
 * anonymously to power the public demo. The personal space is implied when no
 * `space` query is given. A connected space is addressed as `connector:<pluginId>`
 * and is read-only unless its source plugin is writable (a NAS).
 *
 * The WebDAV mount (Basic auth, outside `/api`) and the MCP server (OAuth bearer,
 * outside `/api`) are mounted by the worker but described elsewhere.
 */
@service(#{ title: "Canopy Drive" })
@server("/", "The Canopy API, mounted under /api by the worker.")
@useAuth(BearerAuth)
namespace Canopy;

// ───────────────────────────── health & mounts ───────────────────────────────

@route("/api/health")
@useAuth(NoAuth)
interface HealthApi {
  /** Liveness + which drive/mounts are configured. */
  @get
  @operationId("health")
  health(): Health;
}

@route("/api/file")
@useAuth(NoAuth)
interface MountFiles {
  /**
   * Read one file's bytes from a read-only mount (`?mount=`) or a connected space
   * (`?space=connector:<plugin>`). `?download` forces a save dialog. Legacy
   * path-based shape kept for the Documentation plugin.
   */
  @get
  @operationId("readMountFile")
  read(
    @query mount?: string,
    @query space?: string,
    @query path: string,
    @query download?: boolean,
  ): {
    @header contentType: string;
    @body bytes: bytes;
  } | Error;
}

// ───────────────────────────── spaces ────────────────────────────────────────

@route("/api/spaces")
interface Spaces {
  /** List the spaces the caller can read (personal, group, and connected). */
  @get
  @operationId("listSpaces")
  list(): Space[] | Error;

  /** Create a shared (group) space. */
  @post
  @operationId("createSpace")
  create(@body space: CreateSpace): {
    @statusCode statusCode: 201;
    @body created: Space;
  } | Error;

  /** Rename a space. Owner only. */
  @patch
  @operationId("renameSpace")
  rename(@path id: string, @body body: RenameSpace): Space | Error;

  /** Permanently delete a group space and everything in it. Owner only. */
  @delete
  @operationId("deleteSpace")
  delete(@path id: string): Ok | Error;

  /** Pin/unpin a space into "My Drive". */
  @patch
  @route("/{id}/prefs")
  @operationId("setSpacePrefs")
  prefs(@path id: string, @body body: SpacePrefs): Ok | Error;

  // ── membership ──
  /** Members of a space (incl. pending email invites as member rows). */
  @get
  @route("/{id}/members")
  @operationId("listMembers")
  members(@path id: string): SpaceMember[] | Error;

  /** Add a member by email (they must have signed in once). Owner only. */
  @post
  @route("/{id}/members")
  @operationId("addMember")
  addMember(@path id: string, @body body: AddSpaceMember): {
    @statusCode statusCode: 201;
    @body member: SpaceMember;
  } | Error;

  /** Remove a member. Owner only. */
  @delete
  @route("/{id}/members")
  @operationId("removeMember")
  removeMember(@path id: string, @body body: RemoveSpaceMember): Ok | Error;

  // ── per-space plugins ──
  /** Plugins applied to a space. Any member may read. */
  @get
  @route("/{id}/plugins")
  @operationId("listSpacePlugins")
  plugins(@path id: string): PluginIds | Error;

  /** Apply a plugin to a space (turns it on for everyone). Owner only. */
  @post
  @route("/{id}/plugins")
  @operationId("applySpacePlugin")
  applyPlugin(@path id: string, @body body: { pluginId: string }): {
    @statusCode statusCode: 201;
    @body ok: Ok;
  } | Error;

  /** Remove an applied plugin from a space. Owner only. */
  @delete
  @route("/{id}/plugins/{pluginId}")
  @operationId("removeSpacePlugin")
  removePlugin(@path id: string, @path pluginId: string): Ok | Error;

  // ── invites ──
  /** Mint a single-use invite link. Owner only. */
  @post
  @route("/{id}/invites")
  @operationId("createInvite")
  createInvite(@path id: string, @body body: CreateInvite): {
    @statusCode statusCode: 201;
    @body invite: SpaceInvite;
  } | Error;

  /** List a space's invite links. Owner only. */
  @get
  @route("/{id}/invites")
  @operationId("listInvites")
  invites(@path id: string): SpaceInvite[] | Error;

  /** Revoke an invite link. Owner only. */
  @delete
  @route("/{id}/invites/{token}")
  @operationId("revokeInvite")
  revokeInvite(@path id: string, @path token: string): Ok | Error;

  // ── per-folder sharing (grants on a folder + its subtree) ──
  /** Grants on a folder (`?path=`). */
  @get
  @route("/{id}/folder-grants")
  @operationId("listFolderGrants")
  folderGrants(@path id: string, @query path?: string): Grant[] | Error;

  /** Add a folder grant. (`email` subjects unknown to the directory become pending invites.) */
  @post
  @route("/{id}/folder-grants")
  @operationId("shareFolderGrant")
  shareFolderGrant(@path id: string, @body body: FolderGrantInput): {
    @statusCode statusCode: 201;
    @body ok: Ok;
  } | Error;

  /** Remove a folder grant. */
  @delete
  @route("/{id}/folder-grants")
  @operationId("unshareFolderGrant")
  unshareFolderGrant(@path id: string, @body body: FolderGrantInput): Ok | Error;

  // ── share links (folder/space) ──
  /** List share links for a space, or a folder within it (`?path=`). */
  @get
  @route("/{id}/shares")
  @operationId("listSpaceShares")
  shares(@path id: string, @query path?: string): ShareInfo[] | Error;

  /** Mint a share link for a space, or a folder within it (`path` in the body). */
  @post
  @route("/{id}/shares")
  @operationId("createSpaceShare")
  createShare(@path id: string, @body body: CreateShare): {
    @statusCode statusCode: 201;
    @body created: CreateShareResult;
  } | Error;
}

// ───────────────────────────── invites (recipient side) ──────────────────────

@route("/api/invites")
interface Invites {
  /** Email invites awaiting the caller's verified address (the invites banner). */
  @get
  @route("/pending")
  @operationId("pendingInvites")
  pending(): PendingInvite[] | Error;

  /** Claim all pending email invites for the caller's address. */
  @post
  @route("/pending/accept")
  @operationId("acceptPendingInvites")
  acceptPending(): AcceptPendingResult | Error;

  /** Preview an invite link (no sign-in, so recipients see what they're joining). */
  @get
  @route("/{token}")
  @useAuth(NoAuth)
  @operationId("inviteInfo")
  info(@path token: string): InvitePreview | Error;

  /** Accept an invite link (the signed-in account becomes the member). */
  @post
  @route("/{token}/accept")
  @operationId("acceptInvite")
  accept(@path token: string): AcceptInviteResult | Error;
}

// ───────────────────────────── files ─────────────────────────────────────────

@route("/api/files")
interface Files {
  /**
   * List one folder. Defaults to the personal space root. `?mount=` reads a
   * read-only mount; `?space=connector:<plugin>` a connected space (reconciled on
   * view, `?fresh` bypasses the debounce); `?shared` files shared with me;
   * `?trash` the trash; otherwise `?space=` + `?path=`.
   */
  @get
  @operationId("listFiles")
  list(
    @query mount?: string,
    @query space?: string,
    @query path?: string,
    @query fresh?: boolean,
    @query trash?: boolean,
    @query shared?: boolean,
  ): Listing | Error;

  /**
   * Create a file record plus its first version. The blob must already be prepared
   * and uploaded (see `prepareUpload` / `commitUpload`). Runs AI labeling in the
   * background.
   */
  @post
  @operationId("createFile")
  create(@query space?: string, @body file: CreateFile): {
    @statusCode statusCode: 201;
    @body created: File;
  } | Error;

  /** Fetch a single file (joined with its current version) for display. */
  @get
  @operationId("getFile")
  get(@path id: string): File | Error;

  /**
   * Download the current version's bytes. Serves an `ETag` and honors
   * `If-None-Match` (→ 304). `?download` forces a save dialog.
   */
  @get
  @route("/{id}/content")
  @operationId("getFileContent")
  content(@path id: string, @query download?: boolean): {
    @header contentType: string;
    @header eTag: string;
    @body bytes: bytes;
  } | Error;

  /** Patch a file's freeform metadata (e.g. move it by changing `path`). Never versions. */
  @patch
  @route("/{id}/metadata")
  @operationId("updateFileMetadata")
  updateMetadata(@path id: string, @body metadata: Record<unknown>): File | Error;

  /** Move a file to the trash (soft delete), or `?permanent` to purge it + its content. */
  @delete
  @operationId("deleteFile")
  delete(@path id: string, @query permanent?: boolean): Ok | Error;

  /** Restore a trashed file. */
  @post
  @route("/{id}/restore")
  @operationId("restoreFile")
  restore(@path id: string): Ok | Error;

  // ── versions ──
  /** List a file's version history (newest first). */
  @get
  @route("/{id}/versions")
  @operationId("listVersions")
  versions(@path id: string): VersionEntry[] | Error;

  /** Append a new content version (the blob must be prepared/uploaded). Dedup applies. */
  @post
  @route("/{id}/versions")
  @operationId("addVersion")
  addVersion(@path id: string, @body body: AddVersion): File | Error;

  /** Download a specific past version's bytes. */
  @get
  @route("/{id}/versions/{versionId}/content")
  @operationId("getVersionContent")
  versionContent(@path id: string, @path versionId: string): {
    @header contentType: string;
    @body bytes: bytes;
  } | Error;

  /** Restore an older version: appends its content as the new current version. */
  @post
  @route("/{id}/versions/{versionId}/restore")
  @operationId("restoreVersion")
  restoreVersion(@path id: string, @path versionId: string): File | Error;

  /** Pin/unpin a version so retention never prunes it. */
  @post
  @route("/{id}/versions/{versionId}/keep")
  @operationId("keepVersion")
  keepVersion(@path id: string, @path versionId: string, @body body: KeepVersion): Ok | Error;

  // ── file-scoped uploads (key to the file's own space, gated by editor) ──
  /** Reserve a blob for this file's next version, keyed to the file's space. */
  @post
  @route("/{id}/uploads/prepare")
  @operationId("prepareFileUpload")
  prepareUpload(@path id: string, @body body: PrepareUpload): UploadTicket | Error;

  /** Stream bytes for a file-scoped blob; the token is the claimed SHA-256, re-verified. */
  @put
  @route("/{id}/uploads/{hash}")
  @operationId("commitFileUpload")
  commitUpload(@path id: string, @path hash: string, @body bytes: bytes): {
    @statusCode statusCode: 201;
    @body committed: CommittedBlob;
  } | Error;

  // ── comments ──
  /** A file's comments, oldest first. */
  @get
  @route("/{id}/comments")
  @operationId("listComments")
  comments(@path id: string): Comment[] | Error;

  /** Post a comment. Anyone who can see the file (viewer+) may comment. */
  @post
  @route("/{id}/comments")
  @operationId("addComment")
  addComment(@path id: string, @body body: CreateComment): {
    @statusCode statusCode: 201;
    @body comment: Comment;
  } | Error;

  /** Soft-delete a comment (author or file owner only). */
  @delete
  @route("/{id}/comments/{commentId}")
  @operationId("deleteComment")
  deleteComment(@path id: string, @path commentId: string): Ok | Error;

  // ── per-file sharing: grants ──
  /** Direct grants on a file. */
  @get
  @route("/{id}/grants")
  @operationId("listGrants")
  grants(@path id: string): Grant[] | Error;

  /** Add a grant on a file. (`email` subjects unknown to the directory become pending invites.) */
  @post
  @route("/{id}/grants")
  @operationId("shareGrant")
  shareGrant(@path id: string, @body body: GrantInput): {
    @statusCode statusCode: 201;
    @body ok: Ok;
  } | Error;

  /** Remove a grant on a file. */
  @delete
  @route("/{id}/grants")
  @operationId("unshareGrant")
  unshareGrant(@path id: string, @body body: GrantInput): Ok | Error;

  // ── per-file sharing: links ──
  /** List share links for a file. */
  @get
  @route("/{id}/shares")
  @operationId("listFileShares")
  shares(@path id: string): ShareInfo[] | Error;

  /** Mint a share link for a file (the secret is returned once). */
  @post
  @route("/{id}/shares")
  @operationId("createFileShare")
  createShare(@path id: string, @body body: CreateShare): {
    @statusCode statusCode: 201;
    @body created: CreateShareResult;
  } | Error;
}

// ───────────────────────────── folders & connector writes ────────────────────

@route("/api/folders")
interface Folders {
  /** Create an (empty) folder in a space (or a writable connected space). */
  @post
  @operationId("createFolder")
  create(@query space?: string, @body body: CreateFolder): {
    @statusCode statusCode: 201;
    @body created: Folder | Ok;
  } | Error;
}

@route("/api/connector-files")
interface ConnectorFiles {
  /**
   * Upload bytes straight into a writable connected space (a NAS): write through
   * the connector, reconcile the folder, and return the resulting indexed file.
   * `?space=connector:<plugin>` + `?path=<space-relative path>`; body = raw bytes.
   */
  @put
  @operationId("uploadConnectorFile")
  upload(@query space: string, @query path: string, @body bytes: bytes): {
    @statusCode statusCode: 201;
    @body created: File | Ok;
  } | Error;
}

// ───────────────────────────── uploads (space-keyed) ─────────────────────────

@route("/api/uploads")
interface Uploads {
  /**
   * Reserve an upload for content-addressed bytes in a space. If a blob with this
   * hash already exists, the response says so and the PUT can be skipped.
   */
  @post
  @route("/prepare")
  @operationId("prepareUpload")
  prepare(@query space?: string, @body body: PrepareUpload): UploadTicket | Error;

  /** Stream bytes for a prepared upload. `token` is the claimed SHA-256, re-verified. */
  @put
  @route("/{token}")
  @operationId("commitUpload")
  commit(@path token: string, @body bytes: bytes): {
    @statusCode statusCode: 201;
    @body committed: CommittedBlob;
  } | Error;
}

// ───────────────────────────── drive: search, overview, changes ──────────────

@route("/api")
interface Drive {
  /** Full-text search across the files the caller can read. Empty `q` → no hits. */
  @get
  @route("/search")
  @operationId("search")
  search(@query q: string, @query limit?: int32, @query cursor?: string): SearchResults | Error;

  /** Lightweight stats (file count + bytes used) for a space. */
  @get
  @route("/overview")
  @operationId("getOverview")
  overview(@query space?: string): Overview | Error;

  /**
   * Offline-mirror delta: every file change in the caller's spaces since their
   * cursor. `?since=` is a URL-encoded JSON `{spaceId: seq}` map (absent →
   * bootstrap). `?limit=` caps the page.
   */
  @get
  @route("/changes")
  @operationId("changesSince")
  changes(@query since?: string, @query limit?: int32): ChangesPage | Error;

  /**
   * Live nudge: an SSE stream that emits a `bump` whenever the given space advances
   * (`?space=`, default = personal). 204 when no live channel is bound (Node) — the
   * client polls instead.
   */
  @get
  @route("/changes/stream")
  @operationId("changesStream")
  changesStream(@query space?: string): {
    @header contentType: "text/event-stream";
    @body stream: string;
  } | {
    @statusCode statusCode: 204;
  } | Error;
}

// ───────────────────────────── connected spaces ──────────────────────────────

@route("/api/connector")
interface Connectors {
  /** Force a (re-)index of a connected space ("Sync now"); backgrounded. */
  @post
  @route("/{pluginId}/sync")
  @operationId("syncConnector")
  sync(@path pluginId: string): { started: boolean } | Error;

  /** Indexing state of a connected space (sidebar polls this). */
  @get
  @route("/{pluginId}/status")
  @operationId("connectorStatus")
  status(@path pluginId: string): ConnectorStatus | Error;

  /** SSE stream of the connector crawl's progress lines (204 without a live channel). */
  @get
  @route("/{pluginId}/logs/stream")
  @operationId("connectorLogStream")
  logs(@path pluginId: string): {
    @header contentType: "text/event-stream";
    @body stream: string;
  } | {
    @statusCode statusCode: 204;
  } | Error;

  /** Read the connected space's version-retention policy. */
  @get
  @route("/{pluginId}/settings")
  @operationId("getConnectorSettings")
  getSettings(@path pluginId: string): ConnectorSettings | Error;

  /** Update the connected space's version-retention policy. */
  @put
  @route("/{pluginId}/settings")
  @operationId("setConnectorSettings")
  setSettings(@path pluginId: string, @body body: SetConnectorSettings): ConnectorSettings | Error;

  /** List the connected space's branches (`supported: false` for a NAS). */
  @get
  @route("/{pluginId}/branches")
  @operationId("listBranches")
  branches(@path pluginId: string): BranchList | Error;

  /** Create a branch on the backend (needs a write token). */
  @post
  @route("/{pluginId}/branches")
  @operationId("createBranch")
  createBranch(@path pluginId: string, @body body: CreateBranch): {
    @statusCode statusCode: 201;
    @body ok: Ok;
  } | Error;

  /** Delete a branch on the backend. The name is a query param (`?name=`) for "/"-bearing refs. */
  @delete
  @route("/{pluginId}/branches")
  @operationId("deleteBranch")
  deleteBranch(@path pluginId: string, @query name: string): Ok | Error;

  /** Switch the branch the connected space is rooted at (persist + re-index). */
  @put
  @route("/{pluginId}/branch")
  @operationId("switchBranch")
  switchBranch(@path pluginId: string, @body body: SwitchBranch): { ok: boolean; branch: string } | Error;
}

// ───────────────────────────── processing activity ───────────────────────────

@route("/api/processing")
interface Processing {
  /** Recent processor runs across the caller's spaces. `?plugin=` / `?limit=` filter. */
  @get
  @operationId("recentProcessing")
  list(@query plugin?: string, @query limit?: int32): ProcessingRun[] | Error;
}

// ───────────────────────────── people & shared folders ───────────────────────

@route("/api/people")
interface People {
  /** People the caller is connected to (space co-members + share peers), filtered by `?q=`. */
  @get
  @operationId("connectedPeople")
  list(@query q?: string): Person[] | Error;
}

@route("/api/shared-folders")
interface SharedFolders {
  /** Folders shared with the caller (direct or via a place), enriched with space name. */
  @get
  @operationId("listSharedFolders")
  list(): SharedFolder[] | Error;
}

// ───────────────────────────── share links (global) ──────────────────────────

@route("/api/shares")
interface Shares {
  /** Revoke a share link. */
  @delete
  @route("/{id}")
  @operationId("revokeShare")
  revoke(@path id: string): Ok | Error;
}

@route("/s")
@useAuth(NoAuth)
interface ShareLanding {
  /**
   * Public share landing — the secret in the path IS the credential. A file share
   * streams the bytes; a folder/space share returns a read-only JSON listing.
   * Access runs as the share's creator.
   */
  @get
  @route("/{secret}")
  @operationId("openShare")
  open(@path secret: string): {
    @header contentType: string;
    @body bytes: bytes;
  } | ShareListing | Error;
}

// ───────────────────────────── app passwords ─────────────────────────────────

@route("/api/app-passwords")
interface AppPasswords {
  /** Device passwords for WebDAV / Basic-auth clients. */
  @get
  @operationId("listAppPasswords")
  list(): AppPassword[] | Error;

  /** Create an app password — the plaintext token is returned ONCE. */
  @post
  @operationId("createAppPassword")
  create(@body body: CreateAppPassword): {
    @statusCode statusCode: 201;
    @body created: AppPasswordToken;
  } | Error;

  /** Delete an app password. */
  @delete
  @route("/{id}")
  @operationId("deleteAppPassword")
  delete(@path id: string): Ok | Error;
}

// ───────────────────────────── MCP connections ───────────────────────────────

@route("/api/mcp/connections")
interface McpConnections {
  /** AI assistants that have connected over MCP (read-only, for Settings). */
  @get
  @operationId("listMcpConnections")
  list(): McpClient[] | Error;
}

// ───────────────────────────── AI ────────────────────────────────────────────

@route("/api/ai")
interface Ai {
  /** Models available to the caller (base providers + their own UI-configured ones). */
  @get
  @route("/models")
  @operationId("listAiModels")
  models(): { models: AiModel[] } | Error;

  /** Run inference through the caller's effective gateway (503 when none configured). */
  @post
  @route("/generate")
  @operationId("generate")
  generate(@body body: AiGenerateRequest): AiGenerateResult | Error;
}

// ───────────────────────────── data-source plugins ───────────────────────────

@route("/api/integrations")
@useAuth(NoAuth)
interface IntegrationsApi {
  /** What's connected for the caller (live vs. configure). Works anonymously (demo). */
  @get
  @operationId("getIntegrations")
  get(): Integrations | Error;
}

@route("/api/tasks")
@useAuth(NoAuth)
interface Tasks {
  /** Tasks from the caller's configured source (or the demo default). */
  @get
  @operationId("listTasks")
  list(): TaskList | Error;
}

@route("/api/calendar")
@useAuth(NoAuth)
interface Calendar {
  /** Calendar events from the caller's configured source. `?from=`/`?to=` are ISO 8601. */
  @get
  @operationId("listCalendar")
  list(@query from?: string, @query to?: string): CalendarList | Error;
}

// ───────────────────────────── plugins ───────────────────────────────────────

@route("/api/plugins")
interface Plugins {
  /** Plugins the caller has installed (auth-dependent defaults when none saved). */
  @get
  @route("/installed")
  @operationId("getInstalledPlugins")
  installed(): PluginIds | Error;

  /** Set the caller's installed plugin set. */
  @put
  @route("/installed")
  @operationId("setInstalledPlugins")
  setInstalled(@body body: PluginIds): Ok | Error;

  /** The caller's effective active set (own installs ∪ plugins applied to their spaces). */
  @get
  @route("/active")
  @operationId("getActivePlugins")
  active(): PluginIds | Error;

  // ── Plugin Studio (runtime-authored, sandboxed) ──
  /** Custom (Studio-generated) plugins the caller authored. */
  @get
  @route("/custom")
  @operationId("listCustomPlugins")
  customList(): { plugins: CustomPlugin[] } | Error;

  /** Submit a Studio-generated plugin (validated server-side; 413 if source too large). */
  @post
  @route("/custom")
  @operationId("createCustomPlugin")
  customCreate(@body body: CreateCustomPlugin): {
    @statusCode statusCode: 201;
    @body created: { ok: boolean; id: string };
  } | Error;

  /** Delete a custom plugin. */
  @delete
  @route("/custom/{id}")
  @operationId("deleteCustomPlugin")
  customDelete(@path id: string): Ok | Error;

  // ── per-plugin settings (data sources, processors, the core AI config) ──
  /** A plugin's settings schema + the caller's saved values (secrets never returned). */
  @get
  @route("/{id}/settings")
  @operationId("getPluginSettings")
  getSettings(@path id: string): PluginSettings | Error;

  /** Save a plugin's settings. On connect, a connector-backed source kicks a background index. */
  @put
  @route("/{id}/settings")
  @operationId("setPluginSettings")
  setSettings(@path id: string, @body body: SavePluginSettings): Ok | Error;

  /** Actively exercise a connector-backed plugin (a live root listing) to surface failures. */
  @get
  @route("/{id}/test")
  @operationId("testPlugin")
  test(@path id: string): PluginTestResult | Error;

  /** The places (group spaces the caller owns) a plugin can be applied to. */
  @get
  @route("/{id}/places")
  @operationId("pluginPlaces")
  places(@path id: string): { places: PluginPlace[] } | Error;
}
