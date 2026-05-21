export type FileKind = "folder" | "pdf" | "image" | "note" | "doc" | "audio" | "video";

export interface FileItem {
  id: number;
  name: string;
  kind: FileKind;
  modified: string;
  size: string;
  sharedWith?: string[];
  starred?: boolean;
  /** Connector-relative path, present for items backed by a real storage connector. */
  path?: string;
}

export const DEFAULT_FILES: FileItem[] = [
  { id: 1, name: "Family photos", kind: "folder", modified: "Apr 14, 2026", size: "2.3 GB", sharedWith: ["Maya", "Daniel", "Lily", "Nora"], starred: true },
  { id: 2, name: "House", kind: "folder", modified: "Apr 12, 2026", size: "184 MB", sharedWith: ["Maya", "Daniel"] },
  { id: 3, name: "Kids' school", kind: "folder", modified: "Apr 09, 2026", size: "67 MB", sharedWith: ["Maya", "Daniel"] },
  { id: 4, name: "Maya birthday — 7.heic", kind: "image", modified: "Mar 28, 2026", size: "4.8 MB", sharedWith: ["Daniel", "Lily"] },
  { id: 5, name: "House lease 2024.pdf", kind: "pdf", modified: "Mar 22, 2026", size: "1.2 MB", sharedWith: ["Maya", "Daniel"], starred: true },
  { id: 6, name: "Pediatrician notes.md", kind: "note", modified: "Mar 14, 2026", size: "8 KB" },
  { id: 7, name: "Tax return — joint.pdf", kind: "pdf", modified: "Feb 11, 2026", size: "920 KB" },
  { id: 8, name: "Trip planning.doc", kind: "doc", modified: "Jan 30, 2026", size: "42 KB", sharedWith: ["Maya", "Daniel", "Nora"] },
  { id: 9, name: "Lily — drawings", kind: "folder", modified: "Jan 22, 2026", size: "412 MB", sharedWith: ["Maya", "Lily"] },
  { id: 10, name: "Wifi & router login.md", kind: "note", modified: "Jan 14, 2026", size: "2 KB", sharedWith: ["Maya", "Daniel"] },
  { id: 11, name: "Birthday cake recipe.md", kind: "note", modified: "Jan 8, 2026", size: "3 KB" },
  { id: 12, name: "Insurance — auto.pdf", kind: "pdf", modified: "Dec 28, 2025", size: "640 KB" },
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
  category: "Productivity" | "Finance" | "Lifestyle" | "Security" | "Media" | "Wellness";
  tagline: string;
  popular?: boolean;
  color: string;
}

export const PLUGIN_CATALOG: CatalogItem[] = [
  { id: "calendar", icon: "calendar", label: "Calendar", category: "Productivity", tagline: "Shared family calendar with smart conflicts", popular: true, color: "145 33% 36%" },
  { id: "tasks", icon: "check-square", label: "Tasks", category: "Productivity", tagline: "A real to-do list for the household", popular: true, color: "212 70% 48%" },
  { id: "notes", icon: "file-text", label: "Notes", category: "Productivity", tagline: "Markdown notes that sync everywhere", color: "262 60% 55%" },
  { id: "budgets", icon: "wallet", label: "Budgets", category: "Finance", tagline: "Track spending by category, monthly", color: "20 85% 52%" },
  { id: "recipes", icon: "chef-hat", label: "Recipes", category: "Lifestyle", tagline: "Save and share family recipes", color: "346 70% 50%" },
  { id: "passwords", icon: "key-round", label: "Passwords", category: "Security", tagline: "End-to-end encrypted password vault", color: "240 6% 35%" },
  { id: "photos", icon: "image", label: "Photos", category: "Media", tagline: "Albums, faces, and timelines", popular: true, color: "38 92% 50%" },
  { id: "meals", icon: "utensils", label: "Meals", category: "Lifestyle", tagline: "Weekly menus the family can edit", color: "190 70% 42%" },
  { id: "bookmarks", icon: "bookmark", label: "Bookmarks", category: "Productivity", tagline: "Shared web bookmarks, tagged", color: "262 60% 55%" },
  { id: "habits", icon: "flame", label: "Habits", category: "Wellness", tagline: "Tiny streaks for the whole house", color: "12 80% 55%" },
];

export const STORAGE = { label: "Cloudflare R2", used: "12.4 GB", total: "50 GB", percent: 25 };

export const CURRENT_USER = { name: "Maya Chen", email: "maya@chen.family", initials: "MC" };
