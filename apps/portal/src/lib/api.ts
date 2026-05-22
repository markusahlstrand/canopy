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

function humanSize(bytes?: number): string {
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

/** Shape of a file record returned by the API (FileWithVersion). */
interface ApiFile {
  id: string;
  name: string;
  metadata: Record<string, unknown>;
  updatedAt: string;
  version: { size: number; mime: string | null } | null;
}
interface DriveListing {
  path: string;
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

/** Soft-delete a drive file by id. */
export async function deleteFile(id: string): Promise<void> {
  const res = await fetch(`/api/files/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed: ${res.status}`);
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

export interface Member {
  sub: string;
  role: Role;
  email: string | null;
  name: string | null;
}

export async function listMembers(spaceId: string): Promise<Member[]> {
  const res = await fetch(`/api/spaces/${spaceId}/members`);
  if (!res.ok) throw new Error(`members failed: ${res.status}`);
  return (await res.json()) as Member[];
}

/** Add a member by email (they must have signed in once). */
export async function addMember(spaceId: string, email: string, role: Role): Promise<void> {
  const res = await fetch(`/api/spaces/${spaceId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `add member failed: ${res.status}`);
}

export async function removeMember(spaceId: string, sub: string): Promise<void> {
  const res = await fetch(`/api/spaces/${spaceId}/members`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sub }),
  });
  if (!res.ok) throw new Error(`remove member failed: ${res.status}`);
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

// ── read-only mounts (docs / demo) ───────────────────────────────────────────

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

/** List a read-only mount (e.g. the docs mount). */
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

export function loginUrl(returnTo: string): string {
  return `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
}
