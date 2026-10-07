/**
 * The view model `file-table.tsx` renders, and the mapping from what the vertical reads.
 *
 * Adapted from the portal's `FileItem` rather than copied whole: that shape carried fields
 * this drive has no operations for — `starred`, `sharedWith`, `owner`, `labels`, `tags`,
 * `offline` — and keeping them would put columns on screen that can never fill. What is
 * left is what a scope can answer, and the table's optional props mean the absent ones
 * simply do not render.
 *
 * `kind` exists because the table shows an icon per type, and the type is a presentation
 * fact derived from the mime the version recorded. The drive itself has no notion of a
 * "pdf" — it has a file whose current version says `application/pdf`.
 */

export type FileKind = 'folder' | 'pdf' | 'image' | 'note' | 'doc' | 'audio' | 'video';

/** The colours the icons tint with, by kind — the portal's palette, unchanged. */
export const FILE_KIND_COLOR: Record<FileKind, string> = {
  folder: '210 80% 55%',
  pdf: '0 70% 55%',
  image: '280 60% 58%',
  note: '45 90% 50%',
  doc: '210 70% 50%',
  audio: '160 60% 45%',
  video: '20 80% 55%',
};

export interface FileItem {
  /** A file's id, or the folder's — the table only ever hands it back. */
  id: string;
  name: string;
  /** Optional explanation of a search match, kept as plain text. */
  description?: string;
  /** Actual extracted snippet, distinct from a fallback match explanation. */
  snippet?: string;
  kind: FileKind;
  /** Rendered as-is, so the caller decides between "today" and a date. */
  modified: string;
  /** Rendered as-is: "2.4 MB", or an em dash when nothing has been written. */
  size: string;
  /** Folders navigate; files preview. The table uses it to pick its click behaviour. */
  isFolder: boolean;
  /** A folder's path. The table compares it to decide a drag is not a drop onto itself. */
  path?: string;
}

/** What the browser can show inline, from the mime the stored bytes produced. */
/** Use the old portal's extension mapping when a listing has no version MIME yet. */
export function kindForName(name: string): FileKind {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  if (extension === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg'].includes(extension)) return 'image';
  if (['md', 'txt'].includes(extension)) return 'note';
  if (['mp3', 'wav', 'flac', 'm4a'].includes(extension)) return 'audio';
  if (['mp4', 'mov', 'mkv'].includes(extension)) return 'video';
  return 'doc';
}

export function kindOf(mime: string | null | undefined, name?: string): FileKind {
  if (!mime) return name ? kindForName(name) : 'doc';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('text/') || mime === 'application/json') return 'note';
  return 'doc';
}
