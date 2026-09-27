/**
 * The drive screen — the first of the portal's surfaces to run against the vertical
 * (S12, #64).
 *
 * Ported rather than reinvented: the layout, the row shape, the icon-by-kind and the
 * per-row action menu are the portal's, rebuilt on `@canopy/ui` because the portal's
 * own copies of those primitives live behind its `@/components/ui` alias. What is
 * deliberately NOT here is what the vertical cannot do yet — Move waits on the grant
 * decision (#75), and preview/viewers wait on the plugin seam (#73), so neither appears
 * as a menu item that does nothing.
 *
 * Folders and files are one list, folders first, because that is what a drive looks
 * like — but they are two reads and two entity types underneath, and the actions differ.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Icon, Input, cn } from '@canopy/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@canopy/ui';
import {
  ROOT_FOLDER_ID,
  contentUrl,
  createFolder,
  listFolder,
  listFolders,
  listTrash,
  renameFile,
  renameFolder,
  restoreFile,
  trashFile,
  uploadFile,
  type DriveFile,
  type DriveFolder,
} from './api';

/**
 * Every icon this screen asks for, named once.
 *
 * `Icon` renders a puzzle piece for a name it does not know — a silent fallback, which
 * is the right behaviour for a plugin-supplied name and a trap for ours. Listing them
 * here lets a test assert they all resolve, so a typo is a failure rather than a
 * puzzle piece somebody eventually notices.
 */
export const DRIVE_ICONS = [
  'folder',
  'file-text',
  'chevron-right',
  'trash',
  'plus',
  'upload',
  'more',
] as const;
export type IconName = (typeof DRIVE_ICONS)[number];

/** A breadcrumb: the trail back to the root, built from the folder's own path. */
interface Crumb {
  id: string;
  name: string;
}

export interface DriveScreenProps {
  onError: (message: string | null) => void;
}

export function DriveScreen({ onError }: DriveScreenProps) {
  const [folderId, setFolderId] = useState(ROOT_FOLDER_ID);
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'drive' | 'trash'>('drive');
  const [trash, setTrash] = useState<DriveFile[]>([]);
  const [renaming, setRenaming] = useState<{ kind: 'file' | 'folder'; id: string; name: string } | null>(null);
  const [creating, setCreating] = useState(false);

  /** One refresh for both views, so an action never leaves half the screen stale. */
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      if (view === 'trash') {
        setTrash(await listTrash());
      } else {
        const [subfolders, contents] = await Promise.all([listFolders(folderId), listFolder(folderId)]);
        setFolders(subfolders);
        setFiles(contents);
      }
      onError(null);
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [folderId, view, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = (folder: DriveFolder) => {
    setCrumbs((c) => [...c, { id: folder.id, name: folder.name }]);
    setFolderId(folder.id);
  };

  const upTo = (index: number) => {
    // -1 is the root: the crumb trail holds everything below it.
    setCrumbs((c) => c.slice(0, index + 1));
    setFolderId(index < 0 ? ROOT_FOLDER_ID : crumbs[index]!.id);
  };

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  const onUpload = (input: HTMLInputElement) => {
    const chosen = Array.from(input.files ?? []);
    input.value = '';
    if (chosen.length === 0) return;
    void act(async () => {
      // Sequential on purpose: each upload is a body the isolate holds while it hashes
      // it, and three at once is three times the memory for no wall-clock worth having.
      for (const file of chosen) await uploadFile(folderId, file);
    });
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <nav aria-label="Breadcrumb" className="mr-auto flex items-center gap-1 text-sm">
          <button
            type="button"
            onClick={() => upTo(-1)}
            className={cn(
              'rounded px-1.5 py-0.5 hover:bg-muted',
              folderId === ROOT_FOLDER_ID && view === 'drive' ? 'font-medium' : 'text-muted-foreground',
            )}
          >
            My Drive
          </button>
          {crumbs.map((crumb, i) => (
            <span key={crumb.id} className="flex items-center gap-1">
              <Icon name="chevron-right" className="size-3.5 text-muted-foreground" />
              <button
                type="button"
                onClick={() => upTo(i)}
                className={cn(
                  'rounded px-1.5 py-0.5 hover:bg-muted',
                  i === crumbs.length - 1 ? 'font-medium' : 'text-muted-foreground',
                )}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>

        <Button
          variant={view === 'trash' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setView((v) => (v === 'trash' ? 'drive' : 'trash'))}
        >
          <Icon name="trash" className="size-4" />
          Trash
        </Button>
        {view === 'drive' ? (
          <>
            <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
              <Icon name="plus" className="size-4" />
              New folder
            </Button>
            <Button size="sm" asChild>
              <label>
                <Icon name="upload" className="size-4" />
                Upload
                <input type="file" multiple className="hidden" onChange={(e) => onUpload(e.currentTarget)} />
              </label>
            </Button>
          </>
        ) : null}
      </div>

      {view === 'trash' ? (
        <Rows
          empty="The trash is empty."
          busy={busy}
          rows={trash.map((file) => ({
            key: file.id,
            icon: 'file-text',
            name: file.name,
            meta: file.deleted_at ? `Trashed ${when(file.deleted_at)}` : 'Trashed',
            actions: [{ label: 'Restore', onSelect: () => void act(() => restoreFile(file.id)) }],
          }))}
        />
      ) : (
        <Rows
          empty="Nothing here yet. Upload a file, or make a folder."
          busy={busy}
          rows={[
            ...folders.map((folder) => ({
              key: folder.id,
              icon: 'folder' as const,
              name: folder.name,
              meta: 'Folder',
              onOpen: () => open(folder),
              actions: [
                {
                  label: 'Rename',
                  onSelect: () => setRenaming({ kind: 'folder', id: folder.id, name: folder.name }),
                },
              ],
            })),
            ...files.map((file) => ({
              key: file.id,
              icon: 'file-text' as const,
              name: file.name,
              meta: file.current_version_id ? `Updated ${when(file.updated_at)}` : 'No content yet',
              onOpen: file.current_version_id
                ? () => window.open(contentUrl(file.id), '_blank', 'noopener')
                : undefined,
              actions: [
                ...(file.current_version_id
                  ? [
                      {
                        label: 'Download',
                        onSelect: () => window.open(contentUrl(file.id), '_blank', 'noopener'),
                      },
                    ]
                  : []),
                {
                  label: 'Rename',
                  onSelect: () => setRenaming({ kind: 'file', id: file.id, name: file.name }),
                },
                {
                  label: 'Move to trash',
                  danger: true,
                  onSelect: () => void act(() => trashFile(file.id)),
                },
              ],
            })),
          ]}
        />
      )}

      {creating ? (
        <NameDialog
          title="New folder"
          initial=""
          confirm="Create"
          onCancel={() => setCreating(false)}
          onConfirm={(name) => {
            setCreating(false);
            void act(() => createFolder(folderId, name));
          }}
        />
      ) : null}

      {renaming ? (
        <NameDialog
          title={renaming.kind === 'folder' ? 'Rename folder' : 'Rename file'}
          initial={renaming.name}
          confirm="Rename"
          onCancel={() => setRenaming(null)}
          onConfirm={(name) => {
            const target = renaming;
            setRenaming(null);
            void act(() =>
              target.kind === 'folder' ? renameFolder(target.id, name) : renameFile(target.id, name),
            );
          }}
        />
      ) : null}
    </div>
  );
}

interface Row {
  key: string;
  icon: IconName;
  name: string;
  meta: string;
  onOpen?: () => void;
  actions: { label: string; onSelect: () => void; danger?: boolean }[];
}

/** The list itself: one shape for the drive and the trash, because they differ only in rows. */
function Rows({ rows, empty, busy }: { rows: Row[]; empty: string; busy: boolean }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-border px-4 py-10 text-center text-sm text-muted-foreground">
        {busy ? 'Loading…' : empty}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
      {rows.map((row) => (
        <li key={row.key} className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/50">
          <Icon name={row.icon} className="size-5 text-muted-foreground" />
          <button
            type="button"
            onClick={row.onOpen}
            disabled={!row.onOpen}
            className="min-w-0 flex-1 text-left disabled:cursor-default"
          >
            <span className="block truncate text-sm">{row.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{row.meta}</span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" aria-label={`Actions for ${row.name}`}>
                <Icon name="more" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {row.actions.map((action, i) => (
                <span key={action.label}>
                  {action.danger && i > 0 ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem
                    onSelect={action.onSelect}
                    className={action.danger ? 'text-destructive' : undefined}
                  >
                    {action.label}
                  </DropdownMenuItem>
                </span>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
      ))}
    </ul>
  );
}

/**
 * One name, typed. The same shape the portal's `NameDialog` has, and it exists for the
 * same reason: `window.prompt` cannot be styled, cannot be tested and is blocked
 * outright in some embedded webviews.
 */
function NameDialog({
  title,
  initial,
  confirm,
  onCancel,
  onConfirm,
}: {
  title: string;
  initial: string;
  confirm: string;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  const trimmed = name.trim();
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal>
      <form
        className="w-full max-w-sm rounded-lg border border-border bg-background p-4 shadow-lg"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed) onConfirm(trimmed);
        }}
      >
        <h2 className="mb-3 text-sm font-medium">{title}</h2>
        <Input autoFocus value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <p className="mt-2 text-xs text-muted-foreground">
          A name is one segment: no slashes, and not <code>.</code> or <code>..</code>
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!trimmed}>
            {confirm}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** Dates as the portal shows them: relative while it is useful, absolute after. */
function when(iso: string): string {
  const then = new Date(iso).getTime();
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}
