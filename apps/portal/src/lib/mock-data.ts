export type FileKind = "folder" | "pdf" | "image" | "note" | "doc" | "audio" | "video";

/** One run of a server-side processor over a file, from metadata.processing. */
export interface ProcessingEntry {
  at: string;
  plugin: string;
  status: "ok" | "error";
  model?: string;
  labels?: string[];
  described?: boolean;
  note?: string;
}

export interface FileItem {
  /** File-record id (uuid) for real files; a synthetic `folder:<path>` for folders. */
  id: string;
  name: string;
  kind: FileKind;
  modified: string;
  size: string;
  sharedWith?: string[];
  starred?: boolean;
  /** For folders: the navigate-to virtual path. For files: the folder they live in. */
  path?: string;
  /** Display owner (resolved name/email) and location (space name), for the preview. */
  owner?: string;
  location?: string;
  /** Type labels (e.g. from the Document AI plugin), stored in metadata.labels. */
  labels?: string[];
  /** User-defined tags (distinct from the AI `labels`), stored in metadata.tags. */
  tags?: string[];
  /** Freeform description, stored in metadata.description (may be AI-generated). */
  description?: string;
  /** Per-document processing log (e.g. Document AI runs), stored in metadata.processing. */
  processing?: ProcessingEntry[];
}

export const DEFAULT_FILES: FileItem[] = [
  { id: "1", name: "Family photos", kind: "folder", modified: "Apr 14, 2026", size: "2.3 GB", sharedWith: ["Maya", "Daniel", "Lily", "Nora"], starred: true },
  { id: "2", name: "House", kind: "folder", modified: "Apr 12, 2026", size: "184 MB", sharedWith: ["Maya", "Daniel"] },
  { id: "3", name: "Kids' school", kind: "folder", modified: "Apr 09, 2026", size: "67 MB", sharedWith: ["Maya", "Daniel"] },
  { id: "4", name: "Maya birthday — 7.heic", kind: "image", modified: "Mar 28, 2026", size: "4.8 MB", sharedWith: ["Daniel", "Lily"] },
  { id: "5", name: "House lease 2024.pdf", kind: "pdf", modified: "Mar 22, 2026", size: "1.2 MB", sharedWith: ["Maya", "Daniel"], starred: true },
  { id: "6", name: "Pediatrician notes.md", kind: "note", modified: "Mar 14, 2026", size: "8 KB" },
  { id: "7", name: "Tax return — joint.pdf", kind: "pdf", modified: "Feb 11, 2026", size: "920 KB" },
  { id: "8", name: "Trip planning.doc", kind: "doc", modified: "Jan 30, 2026", size: "42 KB", sharedWith: ["Maya", "Daniel", "Nora"] },
  { id: "9", name: "Lily — drawings", kind: "folder", modified: "Jan 22, 2026", size: "412 MB", sharedWith: ["Maya", "Lily"] },
  { id: "10", name: "Wifi & router login.md", kind: "note", modified: "Jan 14, 2026", size: "2 KB", sharedWith: ["Maya", "Daniel"] },
  { id: "11", name: "Birthday cake recipe.md", kind: "note", modified: "Jan 8, 2026", size: "3 KB" },
  { id: "12", name: "Insurance — auto.pdf", kind: "pdf", modified: "Dec 28, 2025", size: "640 KB" },
];

/** hsl channel triples ("H S% L%") so callers can build hsl() with alpha. */
export const FILE_KIND_COLOR: Record<FileKind, string> = {
  folder: "145 33% 36%",
  pdf: "0 72% 51%",
  image: "38 92% 50%",
  note: "212 92% 50%",
  doc: "248 60% 56%",
  audio: "327 70% 50%",
  video: "190 70% 42%",
};

export const PERSON_COLOR: Record<string, string> = {
  Maya: "145 33% 36%",
  Daniel: "212 70% 48%",
  Lily: "327 60% 55%",
  Nora: "28 80% 55%",
  Alex: "265 50% 55%",
};

export const TONE_COLOR: Record<string, string> = {
  primary: "145 33% 36%",
  info: "212 92% 50%",
  berry: "327 70% 50%",
  accent: "38 92% 50%",
};

export interface CatalogItem {
  id: string;
  icon: string;
  label: string;
  category: "Productivity" | "Finance" | "Lifestyle" | "Security" | "Media" | "Wellness" | "Help";
  tagline: string;
  popular?: boolean;
  color: string;
}

export const PLUGIN_CATALOG: CatalogItem[] = [
  { id: "calendar", icon: "calendar", label: "Calendar", category: "Productivity", tagline: "Shared family calendar with smart conflicts", popular: true, color: "145 33% 36%" },
  { id: "tasks", icon: "check-square", label: "Tasks", category: "Productivity", tagline: "A real to-do list for the household", popular: true, color: "212 70% 48%" },
  { id: "github", icon: "github", label: "GitHub", category: "Productivity", tagline: "Sync issues to Tasks, releases & milestones to Calendar", popular: true, color: "240 6% 20%" },
  { id: "document-ai", icon: "sparkles", label: "Document AI", category: "Productivity", tagline: "Auto-label each document by type with Gemini Flash", popular: true, color: "262 60% 55%" },
  { id: "documentation", icon: "book", label: "Documentation", category: "Help", tagline: "How Canopy works — guides for using it and building plugins", color: "212 70% 48%" },
  { id: "code-editor", icon: "file-code", label: "Code Editor", category: "Productivity", tagline: "Edit code inline with the VS Code editor.", color: "207 90% 54%" },
];

export const STORAGE = { label: "Cloudflare R2", used: "12.4 GB", total: "50 GB", percent: 25 };

export const CURRENT_USER = { name: "Maya Chen", email: "maya@chen.family", initials: "MC" };
