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

/** List a virtual folder of the user's drive. Returns folders first, then files. */
export async function listFiles(dir = ""): Promise<FileItem[]> {
  const res = await fetch(`/api/files?path=${encodeURIComponent(dir)}`);
  if (res.status === 401) return []; // not signed in → empty drive
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  const data: DriveListing = await res.json();
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

/** URL to stream a drive file's current version. */
export function contentUrl(id: string): string {
  return `/api/files/${id}/content`;
}

/** Store bytes content-addressed, skipping the upload if the blob already exists. Returns the hash. */
async function uploadBlob(bytes: Uint8Array): Promise<string> {
  const hash = await sha256hex(bytes);
  const prep = await fetch("/api/uploads/prepare", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hash, size: bytes.byteLength }),
  });
  if (!prep.ok) throw new Error(`prepare failed: ${prep.status}`);
  const { exists } = (await prep.json()) as { exists: boolean };
  if (!exists) {
    const put = await fetch(`/api/uploads/${hash}`, { method: "PUT", body: bytes as unknown as BodyInit });
    if (!put.ok) throw new Error(`upload failed: ${put.status}`);
  }
  return hash;
}

/** Upload files into a virtual folder: hash → dedup-prepare → (PUT if new) → create record. */
export async function uploadFiles(dir: string, files: File[]): Promise<number> {
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await uploadBlob(bytes);
    const res = await fetch("/api/files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: file.name, hash, mime: file.type || undefined, path: dir }),
    });
    if (!res.ok) throw new Error(`create failed: ${res.status}`);
  }
  return files.length;
}

/** Save new text content as a NEW version of a file (metadata untouched). */
export async function saveFileVersion(id: string, text: string, mime = "text/markdown"): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  const hash = await uploadBlob(bytes);
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
