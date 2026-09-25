/**
 * How a file row becomes something the table can show: its kind from the name, its
 * date as a label. Moved out of `api.ts` so the vertical-backed read path can render
 * rows identically without importing the API client — a second copy of this mapping
 * is a second way for two spaces to look different for no reason.
 */
import type { FileKind } from "@/lib/mock-data";

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

export function kindForName(name: string): FileKind {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_KIND[ext] ?? "doc";
}

export function fmtDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
}
