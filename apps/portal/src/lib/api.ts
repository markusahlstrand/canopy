import type { Page, StorageEntry } from "@canopy/core";
import type { FileItem, FileKind } from "@/lib/mock-data";

const EXT_KIND: Record<string, FileKind> = {
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  heic: "image",
  svg: "image",
  md: "note",
  txt: "note",
  doc: "doc",
  docx: "doc",
  pages: "doc",
  mp3: "audio",
  wav: "audio",
  flac: "audio",
  m4a: "audio",
  mp4: "video",
  mov: "video",
  mkv: "video",
};

function kindForName(name: string): FileKind {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_KIND[ext] ?? "doc";
}

export function humanSize(bytes?: number): string {
  if (bytes == null) return "—";
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1000;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
}

const join = (dir: string, name: string) => [dir, name].filter(Boolean).join("/");

/** SHA-256 of bytes as lowercase hex (browser Web Crypto). */
async function sha256hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  let hex = "";
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// ── the drive (DB-backed, content-addressed) ─────────────────────────────────

/** Shape of a file record returned by the API (an enriched FileWithVersion). */
interface ApiFile {
  id: string;
  name: string;
  metadata: Record<string, unknown>;
  updatedAt: string;
  deletedAt?: string | null;
  ownerLabel?: string;
  sharedWith?: string[];
  version: { size: number; mime: string | null } | null;
}
interface DriveListing {
  path: string;
  spaceName?: string;
  files: ApiFile[];
  folders: string[];
}

function toFileItems(data: DriveListing, dir: string): FileItem[] {
  const folders: FileItem[] = data.folders.map((name) => ({
    id: `folder:${join(dir, name)}`,
    name,
    kind: "folder",
    modified: "—",
    size: "—",
    path: join(dir, name),
  }));
  const files: FileItem[] = data.files.map((f) => ({
    id: f.id,
    name: f.name,
    kind: kindForName(f.name),
    modified: fmtDate(f.updatedAt),
    size: humanSize(f.version?.size),
    path: dir,
    sharedWith: f.sharedWith,
    owner: f.ownerLabel,
    location: data.spaceName,
    starred: !!f.metadata?.starred,
    labels: Array.isArray(f.metadata?.labels) ? (f.metadata.labels as string[]) : undefined,
  }));
  return [...folders, ...files];
}

/** List a virtual folder of a space (default: personal). Folders first, then files. */
export async function listFiles(dir = "", spaceId?: string): Promise<FileItem[]> {
  const sp = spaceId ? `&space=${encodeURIComponent(spaceId)}` : "";
  const res = await fetch(`/api/files?path=${encodeURIComponent(dir)}${sp}`);
  if (res.status === 401) return []; // not signed in → empty drive
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  return toFileItems(await res.json(), dir);
}

/** Files shared directly with the caller (outside their own spaces). */
export async function listShared(): Promise<FileItem[]> {
  const res = await fetch("/api/files?shared=1");
  if (!res.ok) return [];
  return toFileItems(await res.json(), "");
}

/** URL to stream a drive file's current version. */
export function contentUrl(id: string): string {
  return `/api/files/${id}/content`;
}

/** Store bytes content-addressed in a space, skipping the upload if it already exists. Returns the hash. */
async function uploadBlob(bytes: Uint8Array, spaceId?: string): Promise<string> {
  const sp = spaceId ? `?space=${encodeURIComponent(spaceId)}` : "";
  const hash = await sha256hex(bytes);
  const prep = await fetch(`/api/uploads/prepare${sp}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hash, size: bytes.byteLength }),
  });
  if (!prep.ok) throw new Error(`prepare failed: ${prep.status}`);
  const { exists } = (await prep.json()) as { exists: boolean };
  if (!exists) {
    const put = await fetch(`/api/uploads/${hash}${sp}`, { method: "PUT", body: bytes as unknown as BodyInit });
    if (!put.ok) throw new Error(`upload failed: ${put.status}`);
  }
  return hash;
}

/** Upload files into a virtual folder of a space: hash → dedup-prepare → (PUT if new) → create record. */
export async function uploadFiles(dir: string, files: File[], spaceId?: string): Promise<number> {
  const sp = spaceId ? `?space=${encodeURIComponent(spaceId)}` : "";
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await uploadBlob(bytes, spaceId);
    const res = await fetch(`/api/files${sp}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: file.name, hash, mime: file.type || undefined, path: dir }),
    });
    if (!res.ok) throw new Error(`create failed: ${res.status}`);
  }
  return files.length;
}

/** Save new text content as a NEW version of a file (metadata untouched). Blob goes in the file's space. */
export async function saveFileVersion(id: string, text: string, mime = "text/markdown", spaceId?: string): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  const hash = await uploadBlob(bytes, spaceId);
  const res = await fetch(`/api/files/${id}/versions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hash, mime }),
  });
  if (!res.ok) throw new Error(`save failed: ${res.status}`);
}

/** One entry in a file's version history (newest first from the API). */
export interface FileVersion {
  id: string;
  size: number;
  mime: string | null;
  source: "blob" | "external";
  createdAt: string;
  createdBy: string;
  createdByLabel: string;
}

/** A file's version history, newest first (the first entry is the current version). */
export async function listVersions(id: string): Promise<FileVersion[]> {
  const res = await fetch(`/api/files/${id}/versions`);
  if (!res.ok) return [];
  return (await res.json()) as FileVersion[];
}

/** Restore an older version — appends its content as the new current version. */
export async function restoreVersion(id: string, versionId: string): Promise<void> {
  const res = await fetch(`/api/files/${id}/versions/${versionId}/restore`, { method: "POST" });
  if (!res.ok) throw new Error(`restore version failed: ${res.status}`);
}

/** Move a drive file to Trash (recoverable). */
export async function deleteFile(id: string): Promise<void> {
  const res = await fetch(`/api/files/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed: ${res.status}`);
}

/** Files in the caller's Trash, newest deletion first. */
export async function listTrash(): Promise<FileItem[]> {
  const res = await fetch("/api/files?trash=1");
  if (res.status === 401) return [];
  if (!res.ok) throw new Error(`trash failed: ${res.status}`);
  const data = (await res.json()) as DriveListing;
  return data.files.map((f) => ({
    id: f.id,
    name: f.name,
    kind: kindForName(f.name),
    modified: fmtDate(f.deletedAt ?? f.updatedAt),
    size: humanSize(f.version?.size),
    path: "",
    owner: f.ownerLabel,
  }));
}

/** Restore a file from Trash. */
export async function restoreFile(id: string): Promise<void> {
  const res = await fetch(`/api/files/${id}/restore`, { method: "POST" });
  if (!res.ok) throw new Error(`restore failed: ${res.status}`);
}

/** Permanently delete a file and its content (irreversible). */
export async function purgeFile(id: string): Promise<void> {
  const res = await fetch(`/api/files/${id}?permanent=1`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed: ${res.status}`);
}

/** Star/unstar a file — persisted as `metadata.starred` (a metadata edit, no new version). */
export async function setStarred(id: string, starred: boolean): Promise<void> {
  const res = await fetch(`/api/files/${id}/metadata`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ starred }),
  });
  if (!res.ok) throw new Error(`star failed: ${res.status}`);
}

/** Move a file into a virtual folder — persisted as `metadata.path` (a metadata edit, no new version). */
export async function moveFile(id: string, path: string): Promise<void> {
  const res = await fetch(`/api/files/${id}/metadata`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(`move failed: ${res.status}`);
}

/** Create an empty folder at a virtual path within a space. */
export async function createFolder(path: string, spaceId?: string): Promise<void> {
  const sp = spaceId ? `?space=${encodeURIComponent(spaceId)}` : "";
  const res = await fetch(`/api/folders${sp}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(`create folder failed: ${res.status}`);
}

export interface Overview {
  files: number;
  bytes: number;
}

/** File count + bytes used in a space (for the dashboard). */
export async function getOverview(spaceId?: string): Promise<Overview> {
  const sp = spaceId ? `?space=${encodeURIComponent(spaceId)}` : "";
  const res = await fetch(`/api/overview${sp}`);
  if (!res.ok) return { files: 0, bytes: 0 };
  return (await res.json()) as Overview;
}

// ── spaces + sharing ─────────────────────────────────────────────────────────

export type Role = "owner" | "editor" | "viewer";

export interface SpaceView {
  id: string;
  name: string;
  kind: "personal" | "group";
  role: Role;
  mounted: boolean;
}

/** Spaces the caller can see, with their role + mount preference. */
export async function listSpaces(): Promise<SpaceView[]> {
  const res = await fetch("/api/spaces");
  if (!res.ok) return [];
  return (await res.json()) as SpaceView[];
}

/** Create a shared (group) space. */
export async function createSpace(name: string): Promise<{ id: string; name: string }> {
  const res = await fetch("/api/spaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`create space failed: ${res.status}`);
  return (await res.json()) as { id: string; name: string };
}

/** Pin/unpin a space into My Drive. */
export async function setSpaceMounted(spaceId: string, mounted: boolean): Promise<void> {
  await fetch(`/api/spaces/${spaceId}/prefs`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mounted }),
  });
}

export interface AppPassword {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listAppPasswords(): Promise<AppPassword[]> {
  const res = await fetch("/api/app-passwords");
  if (!res.ok) return [];
  return (await res.json()) as AppPassword[];
}

/** Create an app password; returns the plaintext token ONCE. */
export async function createAppPassword(name: string): Promise<{ id: string; token: string }> {
  const res = await fetch("/api/app-passwords", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status}`);
  return (await res.json()) as { id: string; token: string };
}

export async function deleteAppPassword(id: string): Promise<void> {
  await fetch(`/api/app-passwords/${id}`, { method: "DELETE" });
}

export interface Member {
  sub: string;
  role: Role;
  email: string | null;
  name: string | null;
  /** A pending email invite (the person hasn't signed in yet). */
  pending: boolean;
}

export async function listMembers(spaceId: string): Promise<Member[]> {
  const res = await fetch(`/api/spaces/${spaceId}/members`);
  if (!res.ok) throw new Error(`members failed: ${res.status}`);
  return (await res.json()) as Member[];
}

/** Add a member by email. Returns the member (or a pending invite if they have no account yet). */
export async function addMember(spaceId: string, email: string, role: Role): Promise<Member> {
  const res = await fetch(`/api/spaces/${spaceId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `add member failed: ${res.status}`);
  return (await res.json()) as Member;
}

/** Remove a member or pending invite by principal (a user sub or an invited email). */
export async function removeMember(spaceId: string, principal: string): Promise<void> {
  const res = await fetch(`/api/spaces/${spaceId}/members`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sub: principal }),
  });
  if (!res.ok) throw new Error(`remove member failed: ${res.status}`);
}

// ── invite links (single-use) ─────────────────────────────────────────────────

export interface SpaceInvite {
  token: string;
  spaceId: string;
  role: Role;
  createdAt: string;
  expiresAt: string | null;
}

export type InviteStatus = "valid" | "used" | "expired" | "not_found";

export interface InviteInfo {
  status: InviteStatus;
  spaceId?: string;
  spaceName?: string;
  role?: Role;
}

/** The shareable URL for an invite token. */
export function inviteUrl(token: string): string {
  return `${window.location.origin}/?invite=${encodeURIComponent(token)}`;
}

/** Mint a single-use invite link for a space at a role. Owner only. */
export async function createInvite(spaceId: string, role: Role): Promise<SpaceInvite> {
  const res = await fetch(`/api/spaces/${spaceId}/invites`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `create invite failed: ${res.status}`);
  return (await res.json()) as SpaceInvite;
}

/** Active (unused, unexpired) invite links for a space. */
export async function listInvites(spaceId: string): Promise<SpaceInvite[]> {
  const res = await fetch(`/api/spaces/${spaceId}/invites`);
  if (!res.ok) return [];
  return (await res.json()) as SpaceInvite[];
}

/** Revoke an invite link before it's used. */
export async function revokeInvite(spaceId: string, token: string): Promise<void> {
  const res = await fetch(`/api/spaces/${spaceId}/invites/${encodeURIComponent(token)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`revoke invite failed: ${res.status}`);
}

/** Preview an invite link — what space/role it grants and whether it's still valid. No sign-in needed. */
export async function getInvite(token: string): Promise<InviteInfo> {
  const res = await fetch(`/api/invites/${encodeURIComponent(token)}`);
  if (!res.ok) return { status: "not_found" };
  return (await res.json()) as InviteInfo;
}

/** Redeem an invite link — the signed-in account joins the space. */
export async function acceptInvite(token: string): Promise<{ spaceId: string; alreadyMember: boolean }> {
  const res = await fetch(`/api/invites/${encodeURIComponent(token)}/accept`, { method: "POST" });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `accept invite failed: ${res.status}`);
  return (await res.json()) as { spaceId: string; alreadyMember: boolean };
}

/** A space the signed-in user has been invited to by email but hasn't joined yet. */
export interface PendingInvite {
  spaceId: string;
  spaceName: string;
  role: Role;
}

/** Spaces the caller was invited to by email that haven't resolved yet (for the banner). */
export async function listPendingInvites(): Promise<PendingInvite[]> {
  const res = await fetch("/api/invites/pending");
  if (!res.ok) return [];
  // Only trust an array shape: a stale/misrouted server can answer 200 with a
  // non-array body (e.g. the `:token` route's `{status}` object), and the banner
  // treats `.length` as the count — a non-array would slip past its empty-guard.
  const data = await res.json().catch(() => null);
  return Array.isArray(data) ? (data as PendingInvite[]) : [];
}

/** Claim all pending email invites for the signed-in (verified) account. */
export async function acceptPendingInvites(): Promise<{ accepted: number }> {
  const res = await fetch("/api/invites/pending/accept", { method: "POST" });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `accept failed: ${res.status}`);
  return (await res.json()) as { accepted: number };
}

export interface Grant {
  relation: Role;
  subjectType: "user" | "space" | "email";
  subjectId: string;
  subjectRelation?: string;
}

/** Current grants on a file (for the Share dialog). */
export async function listGrants(fileId: string): Promise<Grant[]> {
  const res = await fetch(`/api/files/${fileId}/grants`);
  if (!res.ok) throw new Error(`grants failed: ${res.status}`);
  return (await res.json()) as Grant[];
}

/** Share a file with a person (by email) or a space, at a role. */
export async function shareFile(
  fileId: string,
  subject: { subjectType: "user" | "space" | "email"; subjectId: string },
  role: Role,
): Promise<void> {
  const res = await fetch(`/api/files/${fileId}/grants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...subject, role }),
  });
  if (!res.ok) throw new Error(`share failed: ${res.status}`);
}

/** Revoke a grant. */
export async function unshareFile(fileId: string, grant: Grant): Promise<void> {
  const res = await fetch(`/api/files/${fileId}/grants`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(grant),
  });
  if (!res.ok) throw new Error(`unshare failed: ${res.status}`);
}

// ── read-only mounts (documentation / demo) ──────────────────────────────────

function mountEntryToItem(mount: string, e: StorageEntry): FileItem {
  return {
    id: `${mount}:${e.path}`,
    name: e.name,
    kind: e.kind === "folder" ? "folder" : kindForName(e.name),
    modified: fmtDate(e.modifiedAt),
    size: e.kind === "folder" ? "—" : humanSize(e.size),
    path: e.path,
  };
}

/** List a read-only mount (e.g. the documentation mount). */
export async function listMount(path: string, mount: string): Promise<FileItem[]> {
  const res = await fetch(`/api/files?mount=${mount}&path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  const page: Page<StorageEntry> = await res.json();
  return page.items.map((e) => mountEntryToItem(mount, e));
}

/** URL for a file on a read-only mount. */
export function mountFileUrl(path: string, mount: string): string {
  return `/api/file?mount=${mount}&path=${encodeURIComponent(path)}`;
}

export async function readText(path: string, mount: string): Promise<string> {
  const res = await fetch(mountFileUrl(path, mount));
  if (!res.ok) throw new Error(`read failed: ${res.status}`);
  return res.text();
}

// ── auth ─────────────────────────────────────────────────────────────────────

export interface AuthUser {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
}

export interface Me {
  user: AuthUser | null;
  authConfigured: boolean;
}

export async function fetchMe(): Promise<Me> {
  try {
    const res = await fetch("/api/auth/me");
    if (!res.ok) return { user: null, authConfigured: false };
    return (await res.json()) as Me;
  } catch {
    return { user: null, authConfigured: false };
  }
}

// ── installed plugins (persisted per user) ────────────────────────────────────

/**
 * The caller's persisted installed-plugin set, or `null` when it can't be
 * resolved (anonymous → 401, or the API is down) so the caller can fall back to
 * its own default. The server applies the per-user default when nothing is saved.
 */
export async function fetchInstalledPlugins(): Promise<string[] | null> {
  try {
    const res = await fetch("/api/plugins/installed");
    if (!res.ok) return null;
    const data = (await res.json()) as { ids?: unknown };
    return Array.isArray(data.ids) ? data.ids.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

/** Persist the full installed-plugin set. Throws on failure (e.g. anonymous). */
export async function saveInstalledPlugins(ids: string[]): Promise<void> {
  const res = await fetch("/api/plugins/installed", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(`save installed plugins failed: ${res.status}`);
}

// ── plugin data sources (tasks / calendar) ───────────────────────────────────

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  assignee?: string;
  due?: string;
  labels?: string[];
  priority?: "low" | "normal" | "high";
  url?: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end?: string;
  allDay?: boolean;
  kind?: "milestone" | "release" | "issue" | "event";
  url?: string;
  tone?: string;
}

/** What external sources are connected (e.g. GitHub), so views show live vs. sample. */
export interface Integrations {
  /** Source plugin ids available on the server. */
  sources: string[];
  /** The connected GitHub source id, or null if none resolves for the caller. */
  sourceId: string | null;
  /** The resolved repo (for display), or null. */
  repo: string | null;
  /** True when falling back to the server's demo default (not the caller's own). */
  usingDefault: boolean;
}

export async function getIntegrations(): Promise<Integrations> {
  const empty: Integrations = { sources: [], sourceId: null, repo: null, usingDefault: false };
  try {
    const res = await fetch("/api/integrations");
    if (!res.ok) return empty;
    return (await res.json()) as Integrations;
  } catch {
    return empty;
  }
}

// ── generic plugin settings (schema-driven) ───────────────────────────────────

export interface PluginConfigField {
  key: string;
  label: string;
  type: "string" | "secret" | "url" | "boolean";
  required?: boolean;
}

export interface PluginSettings {
  fields: PluginConfigField[];
  /** Current non-secret values. */
  values: Record<string, string>;
  /** Keys of secret fields that have a stored value (the value itself is never sent). */
  secretsSet: string[];
}

/** Fetch a source plugin's settings schema + current values (secrets redacted). */
export async function getPluginSettings(pluginId: string): Promise<PluginSettings | null> {
  const res = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/settings`);
  if (!res.ok) return null;
  return (await res.json()) as PluginSettings;
}

/**
 * Save a plugin's settings. Omit a key to leave it unchanged; an empty secret is
 * treated as "keep existing" server-side (so the user needn't re-enter the token).
 */
export async function savePluginSettings(pluginId: string, values: Record<string, string>): Promise<void> {
  const res = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) throw new Error(`save settings failed: ${res.status}`);
}

/** Tasks from the connected source. `source` is null when nothing is connected. */
export async function getTasks(): Promise<{ source: string | null; tasks: Task[] }> {
  const res = await fetch("/api/tasks");
  if (!res.ok) return { source: null, tasks: [] };
  return (await res.json()) as { source: string | null; tasks: Task[] };
}

/** Calendar events from the connected source. `source` is null when none. */
export async function getCalendar(range?: { from: string; to: string }): Promise<{
  source: string | null;
  events: CalendarEvent[];
}> {
  const q = range ? `?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}` : "";
  const res = await fetch(`/api/calendar${q}`);
  if (!res.ok) return { source: null, events: [] };
  return (await res.json()) as { source: string | null; events: CalendarEvent[] };
}

export function loginUrl(returnTo: string): string {
  return `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
}
