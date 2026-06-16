import "@typespec/http";

using TypeSpec.Http;

namespace Canopy;

// ───────────────────────────── shared enums ──────────────────────────────────

/** Resource-level role. owner ⊃ editor ⊃ viewer. */
enum Role {
  owner,
  editor,
  viewer,
}

/**
 * A drive: one `personal` space per user, shared `group` spaces (e.g. a family),
 * and read-only `connected` spaces — a persisted index over a user's connected
 * backend (a Synology NAS, a GitHub repo).
 */
enum SpaceKind {
  personal,
  group,
  connected,
}

/** Where a version's bytes live: a blob Canopy owns, or a pointer into a connected store. */
enum ContentSource {
  blob,
  external,
}

/**
 * Version-retention policy a space applies to its files' history. `smart` thins on a
 * tiered curve (default), `all` keeps everything, `days` keeps only the last N days.
 * The current + pinned versions survive any policy.
 */
enum VersionPolicyKind {
  all,
  smart,
  days,
}

/** Who a grant/share is granted to. */
enum SubjectType {
  user,
  space,
  email,
}

/** What a share link points at. */
enum ShareObjectType {
  file,
  folder,
  space,
}

// ───────────────────────────── spaces ────────────────────────────────────────

/** A space as returned to the caller, including their role in it. */
model Space {
  @key id: string;
  name: string;
  kind: SpaceKind;
  /** The caller's role in this space. */
  role: Role;
  /** Show inline in "My Drive" (always true for the personal space). */
  mounted?: boolean;
  /** Read-only spaces (an indexed repo) refuse writes. */
  readonly?: boolean;
  /** Optional sidebar icon name. */
  icon?: string | null;
  /** Optional accent color — an HSL triplet like "145 33% 36%". */
  color?: string | null;
  /** Who created the space (absent on synthetic `connected` spaces). */
  createdBy?: string;
  createdAt?: utcDateTime;
  /** Retention policy for this space's file versions. */
  versionPolicy?: VersionPolicyKind;
  /** Retained-day window when `versionPolicy` is `days`, else null. */
  versionDays?: int32 | null;
}

/** Fields accepted when creating a shared (group) space. */
model CreateSpace {
  name: string;
  icon?: string | null;
  color?: string | null;
}

/** Patch body for renaming a space. */
model RenameSpace {
  name?: string;
}

/** Pin/unpin a space into "My Drive". */
model SpacePrefs {
  mounted: boolean;
}

/** A member of a space (or a pending email invite resolved as a member row). */
model SpaceMember {
  /** The user's sub, or "" for a pending email invite. */
  sub: string;
  role: Role;
  email?: string | null;
  name?: string | null;
  /** True for an email invite not yet claimed. */
  pending: boolean;
}

/** Add a member to a space by email (they must have signed in once). */
model AddSpaceMember {
  email: string;
  role: Role;
}

/** Remove a member from a space. */
model RemoveSpaceMember {
  sub: string;
}

// ───────────────────────────── invites ───────────────────────────────────────

/** Whether an invite token can still be redeemed. */
enum InviteStatus {
  valid,
  used,
  expired,
  not_found,
}

/** A single-use invite link with the role baked in. */
model SpaceInvite {
  token: string;
  spaceId: string;
  role: Role;
  createdBy: string;
  createdAt: utcDateTime;
  expiresAt?: utcDateTime | null;
  acceptedBy?: string | null;
  acceptedAt?: utcDateTime | null;
}

/** Mint an invite link. */
model CreateInvite {
  role: Role;
}

/** Public preview of an invite link (no sign-in needed). */
model InvitePreview {
  status: InviteStatus;
  /** Present when `status` is `valid`. */
  spaceId?: string;
  spaceName?: string;
  role?: Role;
}

/** Result of accepting an invite link. */
model AcceptInviteResult {
  spaceId: string;
  /** True if the caller already had that role or better. */
  alreadyMember: boolean;
}

/** An email invite awaiting the caller's (verified) address. */
model PendingInvite {
  spaceId: string;
  spaceName: string;
  role: Role;
}

/** Result of claiming all pending email invites. */
model AcceptPendingResult {
  /** Count of spaces joined. */
  accepted: int32;
}

// ───────────────────────────── files & versions ──────────────────────────────

/** Binds a file to its content at a point in time. */
model FileVersion {
  @key id: string;
  fileId: string;
  source: ContentSource;
  /** Blob storage key (tenant-namespaced hash). Present iff `source` is `blob`. */
  blobKey?: string | null;
  /** Connection id when `source` is `external`, else null. */
  connectorId?: string | null;
  /** Object key in the connected store (external only). */
  externalKey?: string | null;
  /** Backend etag of the external object (external only). */
  etag?: string | null;
  mime?: string | null;
  size: int64;
  createdAt: utcDateTime;
  createdBy: string;
  /** Pinned: retention never prunes a kept version. */
  keep: boolean;
  /** R2 key of cached extracted text (external sources); null until the extract queue runs. */
  contentRef?: string | null;
}

/** A version in a file's history, with a friendly label for who created it. */
model VersionEntry extends FileVersion {
  createdByLabel: string;
}

/**
 * A file: a mutable record that points at its current version, joined with that
 * version. This is the display shape (`getFileForDisplay` / listings): the file
 * record plus its current version, who it's shared with, and a friendly owner label.
 */
model File {
  @key id: string;
  /** The owning space id (the tenant); equals the space the file lives in. */
  tenantId: string;
  ownerId: string;
  name: string;
  currentVersionId?: string | null;
  /** Freeform JSON. `path` holds the virtual-folder location (e.g. "Documents/2026"). */
  metadata?: Record<unknown>;
  createdAt: utcDateTime;
  updatedAt: utcDateTime;
  /** Set when the file is in the trash. */
  deletedAt?: utcDateTime | null;
  /** The current version, joined in. */
  version?: FileVersion | null;
  /** Labels (emails / names / space names) the file is shared with, beyond its owner. */
  sharedWith?: string[];
  ownerLabel?: string;
}

/** A folder entry within a space. */
model Folder {
  name: string;
  path: string;
}

/** One folder's listing within a space: the files and subfolders at `path`. */
model Listing {
  /** The folder path that was listed (root = ""). */
  path: string;
  files: File[];
  folders: Folder[];
  /** Present for connected spaces. */
  spaceName?: string;
}

/** Fields needed to create a file record once its blob has been uploaded. */
model CreateFile {
  name: string;
  /** SHA-256 of the uploaded bytes — ties the record to its prepared blob. */
  hash: string;
  mime?: string;
  /** Virtual-folder location within the space. */
  path?: string;
  metadata?: Record<unknown>;
}

/** Create an (empty) folder in a space. */
model CreateFolder {
  path: string;
}

/** Append a new content version to a file (never alters metadata). */
model AddVersion {
  /** SHA-256 of the new bytes (its blob must be prepared/uploaded). */
  hash: string;
  mime?: string;
  /** Coalesce into the current version if the same author saved recently. */
  coalesce?: boolean;
}

/** Pin/unpin a version so retention never prunes it. */
model KeepVersion {
  keep: boolean;
}

// ───────────────────────────── uploads ───────────────────────────────────────

/** Request to reserve an upload slot for content with the given hash. */
model PrepareUpload {
  /** SHA-256 of the bytes to upload. */
  hash: string;
  size?: int64;
}

/** Where (and whether) to upload. When `exists` is true the blob is already stored. */
model UploadTicket {
  /** True when the content-addressed blob already exists — skip the PUT. */
  exists: boolean;
  upload?: {
    method: "PUT";
    url: string;
  };
}

/** Result of streaming bytes to an upload ticket. */
model CommittedBlob {
  hash: string;
  size: int64;
}

// ───────────────────────────── search & overview ─────────────────────────────

/** One full-text search hit, scored and scoped to the caller's readable spaces. */
model SearchHit {
  @key id: string;
  spaceId: string;
  score: float64;
  title: string;
  snippet?: string;
  kind?: string;
  path?: string;
  modifiedAt?: utcDateTime;
}

/** A page of search hits. */
model SearchResults {
  items: SearchHit[];
  /** Present when more results are available. */
  cursor?: string;
}

/** Lightweight per-space stats for the dashboard. */
model Overview {
  files: int64;
  bytes: int64;
}

// ───────────────────────────── comments ──────────────────────────────────────

/** A comment on a file, with a friendly author label resolved from the directory. */
model Comment {
  @key id: string;
  authorId: string;
  authorLabel: string;
  body: string;
  createdAt: utcDateTime;
  updatedAt: utcDateTime;
}

/** Post a comment. */
model CreateComment {
  body: string;
}

// ───────────────────────────── sharing: grants ───────────────────────────────

/** A direct ACL grant on a file or folder, enriched with the subject's directory info. */
model Grant {
  objectType: ShareObjectType;
  objectId: string;
  /** The granted role (the underlying relation: owner/editor/viewer). */
  relation: string;
  subjectType: SubjectType;
  subjectId: string;
  /** "" for a direct grant; "member" for a space-userset grant. */
  subjectRelation?: string;
  name?: string | null;
  email?: string | null;
  picture?: string | null;
}

/** Add/remove a grant on a file. (For `email`, an unknown address becomes a pending invite.) */
model GrantInput {
  subjectType: SubjectType;
  subjectId: string;
  role: Role;
  subjectRelation?: string;
}

/** Add/remove a grant on a folder (a space path + its subtree). */
model FolderGrantInput {
  path: string;
  subjectType: SubjectType;
  subjectId: string;
  role: Role;
}

/** A folder shared with the caller, enriched with its space name. */
model SharedFolder {
  spaceId: string;
  path: string;
  role: Role;
  spaceName: string;
}

/** A person the caller is connected to (space co-member or file-share peer). */
model Person {
  @key sub: string;
  email?: string | null;
  name?: string | null;
  picture?: string | null;
  updatedAt: utcDateTime;
}

// ───────────────────────────── sharing: links ────────────────────────────────

/** A share link's metadata (the secret itself is returned only once, on create). */
model ShareInfo {
  @key id: string;
  objectType: ShareObjectType;
  spaceId: string;
  /** Non-null only for `file` shares. */
  fileId?: string | null;
  /** Folder path for `folder` shares; "" otherwise. */
  path: string;
  role: Role;
  label?: string | null;
  createdBy: string;
  createdAt: utcDateTime;
  lastUsedAt?: utcDateTime | null;
  expiresAt?: utcDateTime | null;
}

/** Mint a share link. `path` (on a space) makes it a folder share. */
model CreateShare {
  role?: Role;
  label?: string;
  path?: string;
  expiresAt?: utcDateTime | null;
}

/** Result of minting a share link — the secret is shown ONCE. */
model CreateShareResult {
  id: string;
  /** Plaintext capability secret; not recoverable later. */
  secret: string;
}

/** A folder/space share's public landing: a read-only listing plus the link's role. */
model ShareListing {
  objectType: ShareObjectType;
  role: Role;
  path: string;
  files: File[];
  folders: Folder[];
  spaceName?: string;
}

// ───────────────────────────── app passwords ─────────────────────────────────

/** A device password for WebDAV / Basic-auth clients (the token is shown once). */
model AppPassword {
  @key id: string;
  name: string;
  createdAt: utcDateTime;
  lastUsedAt?: utcDateTime | null;
}

/** Create an app password. */
model CreateAppPassword {
  name?: string;
}

/** A newly-minted app password — the plaintext token is returned ONCE. */
model AppPasswordToken {
  id: string;
  token: string;
}

// ───────────────────────────── MCP connections ───────────────────────────────

/** An AI assistant that has connected over MCP (recorded as a side effect of requests). */
model McpClient {
  @key clientId: string;
  name?: string | null;
  version?: string | null;
  firstSeenAt: utcDateTime;
  lastSeenAt: utcDateTime;
}

// ───────────────────────────── connectors ────────────────────────────────────

/** Indexing state of a connected space (for the sidebar "Indexing…" hint). */
model ConnectorStatus {
  /** True while a crawl runs or extraction drains. */
  indexing: boolean;
  /** Versions still queued for text extraction. */
  pending: int32;
  lastIndexedAt?: utcDateTime | null;
}

/** A connected space's version-retention policy. */
model ConnectorSettings {
  policy: VersionPolicyKind;
  /** Retained-day window when `policy` is `days`, else null. */
  days?: int32 | null;
}

/** Update a connected space's version-retention policy. */
model SetConnectorSettings {
  versionPolicy: VersionPolicyKind;
  versionDays?: int32 | null;
}

/** One branch (ref) of a connected repo. */
model BranchInfo {
  name: string;
  /** This is HEAD — never deletable. */
  isDefault: boolean;
  /** The connector is currently rooted here. */
  current: boolean;
  protected?: boolean;
  commitSha?: string;
}

/** The connected space's branches, or `supported: false` for a NAS with no branch concept. */
model BranchList {
  supported: boolean;
  current?: string | null;
  /** Only the owner of the config can persist a switch. */
  canSwitch?: boolean;
  branches: BranchInfo[];
}

/** Create a branch on the backend (from another ref, default = the current branch). */
model CreateBranch {
  name: string;
  from?: string;
}

/** Switch the branch the connected space is rooted at. */
model SwitchBranch {
  branch: string;
}

// ───────────────────────────── processing ────────────────────────────────────

/** One processor run over a file, flattened from the file's metadata log. Newest first. */
model ProcessingRun {
  fileId: string;
  fileName: string;
  spaceName: string;
  at: utcDateTime;
  /** Processor id (e.g. "document-ai"). */
  plugin: string;
  status: "ok" | "error";
  `model`?: string;
  labels?: string[];
  described?: boolean;
  note?: string;
}

// ───────────────────────────── offline mirror (changes) ──────────────────────

/** A live (upsert) file change in the offline-mirror delta. */
model MirrorFile {
  @key id: string;
  spaceId: string;
  name: string;
  /** Virtual folder path, normalized. */
  path: string;
  metadata: Record<unknown>;
  updatedAt: utcDateTime;
  /** Per-space change sequence. */
  seq: int64;
  size?: int64 | null;
  mime?: string | null;
  ownerLabel?: string;
  sharedWith?: string[];
}

/** A delete (tombstone) change in the offline-mirror delta. */
model MirrorTombstone {
  @key id: string;
  spaceId: string;
  seq: int64;
  deleted: true;
}

alias MirrorChange = MirrorFile | MirrorTombstone;

/** Which spaces a `/changes` page covers, with the caller's role + kind in each. */
model MirrorSpace {
  id: string;
  role: string;
  kind?: string;
}

/** A page of the offline-mirror delta: every file change since the caller's cursor. */
model ChangesPage {
  changes: MirrorChange[];
  /** Per-space high-water seq map to send as the next `?since=`. */
  cursor: Record<int64>;
  hasMore: boolean;
  spaces: MirrorSpace[];
}

// ───────────────────────────── plugin settings ───────────────────────────────

/** A choice for a `select`-typed config field. */
model ConfigFieldOption {
  value: string;
  label: string;
}

/** Conditional visibility: show this field only when another field's value is in `in`. */
model ShowWhen {
  field: string;
  in: string[];
}

/** One schema-driven config field for a plugin/processor/AI provider. */
model ConfigField {
  key: string;
  label: string;
  type: "string" | "secret" | "url" | "boolean" | "select";
  required?: boolean;
  /** Choices for a `select` field. */
  options?: ConfigFieldOption[];
  /** Host fills options dynamically (today only "ai-models"). */
  optionsFrom?: "ai-models";
  showWhen?: ShowWhen;
}

/**
 * A plugin's settings: the server-authoritative field schema, the caller's saved
 * non-secret values, and which secret fields are set (secret values never leave the server).
 */
model PluginSettings {
  fields: ConfigField[];
  values: Record<string>;
  secretsSet: string[];
}

/** Save a plugin's settings. Omitted keys are unchanged; empty secret = keep existing. */
model SavePluginSettings {
  values: Record<string | null>;
}

/** Result of actively exercising a connector-backed plugin (a live root listing). */
model PluginTestResult {
  ok: boolean;
  error?: string;
}

/** A group space a plugin can be applied to, flagged with whether it's applied there. */
model PluginPlace {
  spaceId: string;
  name: string;
  applied: boolean;
}

// ───────────────────────────── plugin manifest ───────────────────────────────
// A plugin's declared identity, the capabilities the host grants it (scoped — no
// ambient access), and the declarative UI contribution points it renders into.

/** Read the previewed item's bytes/metadata. */
model CapItemRead {
  kind: "item:read";
}

/** Write back to the item (a new version / metadata). */
model CapItemWrite {
  kind: "item:write";
}

/** Query the full-text index within the caller's scope. */
model CapIndexQuery {
  kind: "index:query";
}

/** Read from named storage connectors. */
model CapStorageRead {
  kind: "storage:read";
  connectors?: string[];
}

/** Fetch from an allow-list of hosts. */
model CapNetFetch {
  kind: "net:fetch";
  hosts: string[];
}

/** Per-plugin key/value scratch storage. */
model CapKv {
  kind: "kv";
}

/** Run inference, optionally restricted to named models. */
model CapAiGenerate {
  kind: "ai:generate";
  models?: string[];
}

/** A capability a plugin declares in its manifest. The host grants only what's declared. */
alias Capability =
  | CapItemRead
  | CapItemWrite
  | CapIndexQuery
  | CapStorageRead
  | CapNetFetch
  | CapKv
  | CapAiGenerate;

/** Server-side hook a plugin can implement (runs inside the sandbox). */
union ServerHook {
  enrichItem: "enrichItem",
  transformUpload: "transformUpload",
}

/** A context-menu entry the plugin adds, optionally restricted to item kinds. */
model ContextMenuContribution {
  id: string;
  label: string;
  icon?: string;
  when?: {
    kinds?: string[];
  };
}

/** A panel the plugin renders into the right-hand rail. */
model RailPanelContribution {
  id: string;
  title: string;
  icon?: string;
}

/** A full-content view shown when the plugin is opened from the sidebar (a standalone app). */
model DetailViewContribution {
  id: string;
  title: string;
  /** Place a launcher in the left sidebar under this named section. */
  nav?: {
    section: string;
  };
  /** Render edge-to-edge (drop the host page chrome). */
  immersive?: boolean;
}

/** A field the plugin adds to the file-preview details grid. */
model DetailFieldContribution {
  id: string;
  label: string;
}

/** A sandboxed viewer the plugin renders for matching file types. */
model ViewerContribution {
  id: string;
  title?: string;
  /** MIME types and/or extensions: "application/pdf", "image/*", ".heic", or "pdf". */
  match: string[];
  /** Fill the preview box instead of auto-growing to content. */
  fill?: boolean;
  /** Take over the whole surface when expanded full screen. */
  immersive?: boolean;
}

/** A file type the plugin can create from the host's "New" menu. */
model FileCreatorContribution {
  id: string;
  label: string;
  icon?: string;
  defaultName: string;
  /** Extension appended to the name, including the dot (e.g. ".md"). */
  extension: string;
  mime?: string;
  /** Optional starter content (UTF-8 text). */
  template?: string;
}

/** How the plugin appears in the plugin store. */
model StoreListing {
  category: "Productivity" | "Finance" | "Lifestyle" | "Security" | "Media" | "Wellness" | "Help";
  tagline: string;
  popular?: boolean;
}

/** Declares the plugin contributes typed data sources (tasks / calendar). */
model DataSourceContribution {
  provides: ("tasks" | "calendar")[];
  config?: ConfigField[];
}

/** The declarative UI contribution points a plugin's manifest can declare. */
model Contributions {
  contextMenu?: ContextMenuContribution[];
  railPanel?: RailPanelContribution;
  detailView?: DetailViewContribution;
  detailFields?: DetailFieldContribution[];
  viewers?: ViewerContribution[];
  creators?: FileCreatorContribution[];
  store?: StoreListing;
  dataSource?: DataSourceContribution;
}

/** A plugin's manifest: identity, declared capabilities, and UI contributions. */
model PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** lucide icon name for sidebar / rail / store surfaces. */
  icon?: string;
  /** hsl() accent string for tinted icon backgrounds. */
  color?: string;
  /** Entry module path within the source bundle, relative to the manifest. */
  entry?: string;
  capabilities: Capability[];
  serverHooks?: ServerHook[];
  contributes?: Contributions;
}

// ───────────────────────────── installed / custom plugins ────────────────────

/** A set of plugin ids (installed / active / a space's applied plugins). */
model PluginIds {
  ids: string[];
}

/**
 * A runtime-authored (Plugin Studio) plugin: its manifest + sandboxed ESM source.
 * Studio plugins are a subset of the manifest surface — a file viewer
 * (`contributes.viewers`) or a standalone app (`contributes.detailView`) — and may
 * only declare sandbox-safe capabilities (`item:read`, `item:write`, `net:fetch`).
 */
model CustomPlugin {
  @key id: string;
  /** The parsed manifest (validated against the manifest schema on save). */
  manifest: PluginManifest;
  /** ESM source for the sandboxed viewer/app entry. */
  source: string;
  createdAt: utcDateTime;
  updatedAt: utcDateTime;
}

/** Submit a Studio-generated plugin (manifest + source). */
model CreateCustomPlugin {
  manifest: PluginManifest;
  source: string;
}

// ───────────────────────────── AI ────────────────────────────────────────────

/** A model the caller can run (base providers + their own UI-configured ones). */
model AiModel {
  @key id: string;
  label: string;
  provider: string;
  /** True if the model accepts inline images/documents. */
  vision?: boolean;
}

model AiTextPart {
  kind: "text";
  text: string;
}

model AiImagePart {
  kind: "image";
  mime: string;
  bytes: bytes;
}

alias AiContentPart = AiTextPart | AiImagePart;

/** One chat message. A bare string `content` is shorthand for a single text part. */
model AiMessage {
  role: "system" | "user" | "assistant";
  content: string | AiContentPart[];
}

/** Run inference through the caller's effective gateway. */
model AiGenerateRequest {
  /** Model id from `/api/ai/models`; defaults to the first available. */
  `model`?: string;
  messages: AiMessage[];
  temperature?: float64;
  /** Server caps this at 32768. */
  maxTokens?: int32;
  /** Request a strict-JSON reply where supported. */
  json?: boolean;
}

/** The generation result. */
model AiGenerateResult {
  /** Generated text (a JSON string when `json: true` was requested). */
  text: string;
  /** The model actually used. */
  `model`: string;
}

// ───────────────────────────── data-source plugins ───────────────────────────

/** What's connected for the caller (the integrations panel). */
model Integrations {
  /** Available data-source plugin ids (e.g. ["github"]). */
  sources: string[];
  /** The currently configured source, or null. */
  sourceId?: string | null;
  repo?: string | null;
  /** True when falling back to the public demo default. */
  usingDefault: boolean;
}

/** A task surfaced by a data-source plugin. */
model Task {
  @key id: string;
  title: string;
  status: "todo" | "in_progress" | "blocked" | "done";
  assignee?: string;
  due?: string;
  labels?: string[];
  priority?: "low" | "normal" | "high";
  url?: string;
}

/** Tasks from the active source. */
model TaskList {
  source?: string | null;
  tasks: Task[];
}

/** A calendar event surfaced by a data-source plugin. */
model CalendarEvent {
  @key id: string;
  title: string;
  /** ISO 8601 (date or date-time). */
  start: string;
  /** ISO 8601; omit for all-day / point-in-time events. */
  end?: string;
  allDay?: boolean;
  kind?: "milestone" | "release" | "issue" | "event";
  url?: string;
  /** Accent token. */
  tone?: string;
}

/** Events from the active source. */
model CalendarList {
  source?: string | null;
  events: CalendarEvent[];
}

// ───────────────────────────── misc ──────────────────────────────────────────

/** Liveness + which drive/mounts are configured. */
model Health {
  ok: boolean;
  drive: boolean;
  mounts: string[];
}

/** The generic success envelope returned by mutating routes that have no body. */
model Ok {
  ok: boolean;
}

@error
model Error {
  /** HTTP-aligned error code. */
  code: int32;
  message: string;
}
