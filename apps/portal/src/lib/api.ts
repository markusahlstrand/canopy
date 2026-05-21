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

function toFileItem(entry: StorageEntry, id: number): FileItem {
  return {
    id,
    name: entry.name,
    kind: entry.kind === "folder" ? "folder" : kindForName(entry.name),
    modified: fmtDate(entry.modifiedAt),
    size: entry.kind === "folder" ? "—" : humanSize(entry.size),
    path: entry.path,
  };
}

export async function listFiles(path: string, mount = "local"): Promise<FileItem[]> {
  const res = await fetch(`/api/files?mount=${mount}&path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  const page: Page<StorageEntry> = await res.json();
  return page.items.map((entry, i) => toFileItem(entry, i + 1));
}

export function fileUrl(path: string, mount = "local"): string {
  return `/api/file?mount=${mount}&path=${encodeURIComponent(path)}`;
}

export async function readText(path: string, mount = "local"): Promise<string> {
  const res = await fetch(fileUrl(path, mount));
  if (!res.ok) throw new Error(`read failed: ${res.status}`);
  return res.text();
}

export async function uploadFiles(dir: string, files: File[]): Promise<number> {
  const form = new FormData();
  for (const f of files) form.append("file", f);
  const res = await fetch(`/api/upload?path=${encodeURIComponent(dir)}`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return files.length;
}

export async function deleteFile(path: string): Promise<void> {
  const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed: ${res.status}`);
}

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
