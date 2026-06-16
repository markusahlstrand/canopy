/**
 * Shared read logic for Canopy's offline metadata mirror — the "same code on both
 * sides" of the sync boundary. These pure functions run over D1 rows on the server
 * (the `GET /api/changes` delta endpoint) and over the IndexedDB mirror in the
 * browser, so the folder a user sees offline is derived by the exact same code that
 * produced it online. The package is dependency-free (no `idb`, no D1): the storage
 * binding lives in the caller; here we only shape and fold rows.
 *
 * The mirror holds *metadata only* — file bytes stay in the browser's separate
 * content cache. A {@link MirrorFile} is the small, sync-friendly projection of a
 * server file row carrying just what a drive listing needs.
 */

/** A file row in the browser metadata mirror — emitted by the delta endpoint and
 *  stored client-side, keyed by `id`. The projection of a server `files` row + its
 *  current version that the drive listing renders. */
export interface MirrorFile {
  id: string;
  /** The space (server `tenant_id`) the file lives in. */
  spaceId: string;
  name: string;
  /** Virtual-folder path (server `metadata.path`), normalized. "" = space root. */
  path: string;
  /** Freeform metadata JSON (starred, labels, tags, description, processing, …). */
  metadata: Record<string, unknown>;
  updatedAt: string;
  /** The per-space change sequence this row was last stamped with (the sync cursor). */
  seq: number;
  /** Current version's byte size, or null when the file has no content yet. */
  size: number | null;
  /** Current version's MIME type, or null. */
  mime: string | null;
  /** Friendly owner label, when the endpoint enriched it. */
  ownerLabel?: string;
  /** Labels the file is shared with beyond its owner, when enriched. */
  sharedWith?: string[];
}

/** A tombstone: a file removed from a space (soft-deleted, purged, or reconciled away). */
export interface MirrorTombstone {
  id: string;
  spaceId: string;
  seq: number;
  deleted: true;
}

/** One entry in a delta response: a live row to upsert, or a tombstone to drop. */
export type MirrorChange = (MirrorFile & { deleted?: false }) | MirrorTombstone;

/** One space in the caller's ACL scope. `kind` is load-bearing on the client: the
 *  personal drive (which has no explicit space id in the UI) is resolved by it. */
export interface MirrorScopeEntry {
  id: string;
  role: string;
  kind?: string;
}

/** The wire shape of `GET /api/changes`. `cursor` is a per-space high-water seq map
 *  the client persists and echoes back as `since`; `spaces` is the caller's current
 *  ACL scope so the client can drop a space it no longer has access to. */
export interface DeltaResponse {
  changes: MirrorChange[];
  cursor: Record<string, number>;
  hasMore: boolean;
  spaces: MirrorScopeEntry[];
}

/**
 * Persistence adapter for the offline metadata mirror — the seam that lets the same
 * application code (lib/sync.ts) run over different local engines. Today an IndexedDB
 * implementation backs it (`idbMirrorStore`); a Drizzle + SQLite-WASM (OPFS)
 * implementation could be dropped in unchanged, since `sync.ts` depends only on this
 * interface. Pure storage primitives — sync orchestration (paging, prune-to-scope,
 * folder derivation) lives in the caller, so an adapter just has to read/write rows,
 * cursors, and scope.
 */
export interface MirrorStore {
  /** Every (live) mirror row for a space — the input to {@link folderView}. */
  readSpace(spaceId: string): Promise<MirrorFile[]>;
  /** Apply a delta batch (upsert live rows, delete tombstones) atomically. */
  applyChanges(changes: MirrorChange[]): Promise<void>;
  /** Delete every row for a space (access revoked, or a reset). */
  dropSpace(spaceId: string): Promise<void>;
  /** The persisted per-space high-water seq map (the `since` cursor). */
  readCursors(): Promise<Record<string, number>>;
  writeCursors(cursors: Record<string, number>): Promise<void>;
  /** The persisted ACL scope (used to resolve the personal drive + prune). */
  readScope(): Promise<MirrorScopeEntry[]>;
  writeScope(scope: MirrorScopeEntry[]): Promise<void>;
}

/** Whether a change is a tombstone (type guard). */
export function isTombstone(c: MirrorChange): c is MirrorTombstone {
  return (c as MirrorTombstone).deleted === true;
}

/** Normalize a virtual-folder path: trim slashes, drop empty/`.` segments.
 *  Shared with `@canopy/store` (re-exported there) so client and server agree. */
export function normPath(path: string): string {
  return path
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== ".")
    .join("/");
}

/** Immediate child folder names of `dir`, derived from a set of file paths. */
export function subfolders(dir: string, paths: string[]): string[] {
  const prefix = dir ? `${dir}/` : "";
  const names = new Set<string>();
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (!rest) continue;
    names.add(rest.split("/")[0]!);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * The drive's view of one virtual folder, derived from the mirror's rows — the JS
 * twin of `FileService.list`: the live files directly in `dir` (sorted by name),
 * plus the immediate child folder names derived from every file path in the space.
 * Pass the full row set for the space (folders are derived from all paths, not just
 * those at `dir`). Tombstones must already be excluded (the mirror stores only live
 * rows), but we filter defensively.
 */
export function folderView(
  rows: Iterable<MirrorFile>,
  dir: string,
): { files: MirrorFile[]; folders: string[] } {
  const path = normPath(dir);
  const all = [...rows];
  const files = all
    .filter((r) => r.path === path)
    .sort((a, b) => a.name.localeCompare(b.name));
  const folders = subfolders(
    path,
    all.map((r) => r.path),
  );
  return { files, folders };
}

/**
 * Fold a delta's changes into a map of mirror rows keyed by id (mutates and returns
 * the same map): upsert live rows, remove tombstones. Pure — the persistence binding
 * (IndexedDB write) is the caller's job.
 */
export function applyDelta(byId: Map<string, MirrorFile>, changes: MirrorChange[]): Map<string, MirrorFile> {
  for (const c of changes) {
    if (isTombstone(c)) byId.delete(c.id);
    else {
      const { deleted: _deleted, ...row } = c;
      byId.set(row.id, row);
    }
  }
  return byId;
}

/** The highest seq across a batch of changes, for advancing a cursor. 0 when empty. */
export function maxSeq(changes: MirrorChange[]): number {
  let max = 0;
  for (const c of changes) if (c.seq > max) max = c.seq;
  return max;
}
