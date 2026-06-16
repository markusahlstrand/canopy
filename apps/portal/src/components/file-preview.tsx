import { Suspense, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ShareDialog } from "@/components/share-dialog";
import { Icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { FileIcon } from "@/components/file-icon";
import { AvatarGroup, PersonAvatar } from "@/components/person-avatar";
import { PluginViewer } from "@/components/plugin-viewer";
import { findViewer } from "@/plugins/viewers";
import { PLUGIN_UI } from "@/plugins";
import {
  addComment,
  contentUrl,
  deleteComment,
  downloadFile,
  downloadVersion,
  fetchMe,
  humanSize,
  isItemOffline,
  setItemOffline,
  listComments,
  listVersions,
  restoreVersion,
  saveFileVersion,
  setVersionKeep,
  subscribeContentUpdate,
  setDescription as apiSetDescription,
  setTags as apiSetTags,
  type Comment,
  type FileVersion,
} from "@/lib/api";
import { FILE_KIND_COLOR, STORAGE, type FileItem, type ProcessingEntry } from "@/lib/mock-data";

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-[13.5px]">{children}</div>
    </div>
  );
}

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** A file's saved versions, newest first. Older entries can be restored or downloaded. */
export function VersionHistory({
  fileId,
  fileName,
  onRestored,
  className,
}: {
  fileId: string;
  fileName: string;
  onRestored: () => void;
  className?: string;
}) {
  const [versions, setVersions] = useState<FileVersion[] | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [keeping, setKeeping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listVersions(fileId)
      .then((v) => active && setVersions(v))
      .catch(() => active && setVersions([]));
    return () => {
      active = false;
    };
  }, [fileId, reload]);

  if (versions && versions.length === 0) return null; // no history (e.g. read-only mounts)

  async function restore(versionId: string) {
    setBusy(versionId);
    setError(null);
    try {
      await restoreVersion(fileId, versionId);
      onRestored();
      setReload((n) => n + 1);
    } catch {
      setError("Couldn't restore that version.");
    } finally {
      setBusy(null);
    }
  }

  async function toggleKeep(versionId: string, next: boolean) {
    setKeeping(versionId);
    setError(null);
    try {
      await setVersionKeep(fileId, versionId, next);
      setReload((n) => n + 1);
    } catch {
      setError("Couldn't update that version.");
    } finally {
      setKeeping(null);
    }
  }

  return (
    <div className={className}>
      <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Version history</div>
      {error && <div className="mb-2 text-[12px] text-destructive">{error}</div>}
      {versions == null ? (
        <div className="text-[12.5px] text-muted-foreground">Loading…</div>
      ) : (
        <div className="flex flex-col">
          {versions.map((v, i) => (
            <div key={v.id} className="flex items-center gap-2.5 border-b py-2 last:border-0">
              <PersonAvatar name={v.createdByLabel} size="md" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] font-medium">{v.createdByLabel}</span>
                  {i === 0 && (
                    <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10.5px] font-medium text-primary">
                      Current
                    </span>
                  )}
                </div>
                <div className="font-mono text-[11.5px] text-muted-foreground">
                  {fmtWhen(v.createdAt)} · {humanSize(v.size)}
                </div>
              </div>
              <div className="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={keeping != null}
                  title={v.keep ? "Pinned — kept from pruning. Click to unpin." : "Keep this version (never prune it)"}
                  onClick={() => toggleKeep(v.id, !v.keep)}
                >
                  <Icon name="bookmark" size={14} className={cn(v.keep ? "text-primary" : "text-muted-foreground")} />
                </Button>
                {v.source === "blob" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    title="Download this version"
                    onClick={() => downloadVersion(fileId, v.id, fileName)}
                  >
                    <Icon name="download" size={14} />
                  </Button>
                )}
                {i !== 0 && (
                  <Button variant="ghost" size="sm" disabled={busy != null} onClick={() => restore(v.id)}>
                    {busy === v.id ? "Restoring…" : "Restore"}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</div>;
}

/** Inline-editable description, persisted to metadata.description. Save appears when changed. */
function DescriptionEditor({ fileId, initial, onSaved }: { fileId: string; initial: string; onSaved?: () => void }) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = value !== saved;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await apiSetDescription(fileId, value);
      setSaved(value);
      onSaved?.();
    } catch {
      setError("Couldn't save the description.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <textarea
        className="min-h-[68px] w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-[13.5px] outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
        placeholder="Add a description…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {error && <div className="mt-1 text-[11.5px] text-destructive">{error}</div>}
      {dirty && (
        <div className="mt-1.5 flex gap-2">
          <Button size="sm" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setValue(saved)} disabled={busy}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

/** Editable tag chips, persisted to metadata.tags. Each change writes the full set. */
function TagEditor({ fileId, initial, onSaved }: { fileId: string; initial: string[]; onSaved?: () => void }) {
  const [tags, setTags] = useState<string[]>(initial);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function commit(next: string[]) {
    const prev = tags;
    setTags(next);
    setError(null);
    try {
      await apiSetTags(fileId, next);
      onSaved?.();
    } catch {
      setTags(prev); // roll back the optimistic change
      setError("Couldn't save tags.");
    }
  }

  function add() {
    const t = draft.trim();
    setDraft("");
    if (!t || tags.includes(t)) return;
    void commit([...tags, t]);
  }

  return (
    <div>
      {tags.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11.5px] font-medium text-secondary-foreground"
            >
              <Icon name="hash" size={11} />
              {t}
              <button
                type="button"
                onClick={() => void commit(tags.filter((x) => x !== t))}
                aria-label={`Remove tag ${t}`}
                className="text-muted-foreground transition hover:text-destructive"
              >
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        className="h-8 text-[12.5px]"
        placeholder="Add a tag…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
      />
      {error && <div className="mt-1 text-[11.5px] text-destructive">{error}</div>}
    </div>
  );
}

/** A file's comment thread, fetched live. Anyone who can see the file can post. */
function Comments({ fileId }: { fileId: string }) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [myName, setMyName] = useState("You");
  const [demo, setDemo] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([listComments(fileId), fetchMe()])
      .then(([list, meRes]) => {
        if (!active) return;
        setComments(list);
        setMe(meRes.user?.sub ?? null);
        setMyName(meRes.user?.name ?? meRes.user?.email ?? "You");
        setDemo(!meRes.authConfigured);
      })
      .catch(() => active && setComments([]));
    return () => {
      active = false;
    };
  }, [fileId]);

  async function submit() {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await addComment(fileId, body);
      setComments((cur) => [...(cur ?? []), created]);
      setDraft("");
    } catch {
      setError("Couldn't post your comment.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await deleteComment(fileId, id);
      setComments((cur) => (cur ?? []).filter((c) => c.id !== id));
    } catch {
      setError("Couldn't delete that comment.");
    }
  }

  // In demo mode there's one shared user, so allow deleting any; otherwise only your own.
  const canDelete = (c: Comment) => demo || (me != null && me === c.authorId);

  return (
    <div>
      <SectionLabel>Comments</SectionLabel>
      {error && <div className="mb-2 text-[12px] text-destructive">{error}</div>}
      <div className="flex flex-col gap-4">
        {comments == null ? (
          <div className="text-[12.5px] text-muted-foreground">Loading…</div>
        ) : comments.length === 0 ? (
          <div className="text-[12.5px] text-muted-foreground">No comments yet.</div>
        ) : (
          comments.map((c) => (
            <div key={c.id} className="group flex gap-2.5">
              <PersonAvatar name={c.authorLabel} size="md" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] font-medium">{c.authorLabel}</span>
                  <span className="text-[11.5px] text-muted-foreground">{fmtWhen(c.createdAt)}</span>
                  {canDelete(c) && (
                    <button
                      type="button"
                      onClick={() => void remove(c.id)}
                      aria-label="Delete comment"
                      className="ml-auto text-muted-foreground opacity-0 transition hover:text-destructive group-hover:opacity-100"
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  )}
                </div>
                <p className="whitespace-pre-wrap text-[13.5px]">{c.body}</p>
              </div>
            </div>
          ))
        )}
        <div className="flex items-center gap-2.5">
          <PersonAvatar name={myName} size="md" />
          <Input
            placeholder="Add a comment…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            disabled={busy}
          />
          <Button size="sm" onClick={() => void submit()} disabled={busy || !draft.trim()}>
            Post
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Turn a processor id ("document-ai") into a friendly name ("Document AI"). */
function pluginLabel(id: string): string {
  return id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Per-document processing log — what server-side processors (e.g. Document AI) did
 * to this file and when, newest first. Lets a user confirm a file was processed
 * correctly, and see any failures.
 */
function ProcessingLog({ entries }: { entries: ProcessingEntry[] }) {
  if (entries.length === 0) return null;
  const newestFirst = [...entries].reverse();
  return (
    <div>
      <SectionLabel>Processing</SectionLabel>
      <div className="flex flex-col">
        {newestFirst.map((e, i) => {
          const summary =
            e.status === "error"
              ? (e.note ?? "Failed")
              : [e.labels?.length ? e.labels.join(", ") : null, e.described ? "description" : null]
                  .filter(Boolean)
                  .join(" · ") || "No changes";
          return (
            <div key={`${e.at}:${i}`} className="flex items-start gap-2.5 border-b py-2 last:border-0">
              <span
                className={`mt-1.5 size-2 shrink-0 rounded-full ${e.status === "error" ? "bg-destructive" : "bg-primary"}`}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] font-medium">{pluginLabel(e.plugin)}</span>
                  {e.model && <span className="font-mono text-[11px] text-muted-foreground">{e.model}</span>}
                  <span className="ml-auto font-mono text-[11.5px] text-muted-foreground">{fmtWhen(e.at)}</span>
                </div>
                <div className={`text-[12.5px] ${e.status === "error" ? "text-destructive" : "text-muted-foreground"}`}>
                  {summary}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export type PreviewMode = "split" | "full";

/** True when focus is in a text field, so the preview's arrow-key navigation yields
 *  to the caret (editing a description, tags, or a comment). */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

/** Lightbox-style prev/next control overlaid on the full-screen viewer. */
function NavArrow({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === "left" ? "Previous file" : "Next file"}
      className={cn(
        "absolute top-1/2 z-10 grid size-10 -translate-y-1/2 place-items-center rounded-full border bg-background/80 text-foreground shadow-md backdrop-blur transition hover:bg-background",
        side === "left" ? "left-4" : "right-4",
      )}
    >
      <Icon name={side === "left" ? "chevron-left" : "chevron-right"} size={20} />
    </button>
  );
}

export function FilePreview({
  file,
  space,
  mode,
  onToggleMode,
  onClose,
  onSaved,
  onPrev,
  onNext,
  installedPluginIds,
}: {
  file: FileItem | null;
  /** The current view's space token, so opened bytes count against its offline cache budget. */
  space?: string;
  /** "split" docks beside the (still-interactive) file list; "full" covers the viewport. */
  mode: PreviewMode;
  onToggleMode: () => void;
  onClose: () => void;
  onSaved?: () => void;
  /** Step to the previous / next previewable file in the list (arrow keys + the on-screen
   *  arrows). Undefined when there's no neighbour in that direction. */
  onPrev?: () => void;
  onNext?: () => void;
  /** Plugins active for this user — gates store-listed viewers (e.g. code-editor). */
  installedPluginIds?: string[];
}) {
  const [shareOpen, setShareOpen] = useState(false);
  // Bumped after a restore to remount the viewer so it refetches the current content.
  const [contentNonce, setContentNonce] = useState(0);

  // Stale-while-revalidate: if a background check finds this file's bytes changed
  // upstream, remount the viewer so it reloads the now-fresh cached content. Rare
  // (Canopy is the single point of entry), so this almost never fires.
  useEffect(() => {
    if (!file || file.kind === "folder") return;
    return subscribeContentUpdate(contentUrl(file.id), () => setContentNonce((n) => n + 1));
  }, [file?.id, file?.kind]);

  // "Available offline" toggle: a per-device pin that guarantees this file's bytes are kept
  // and never evicted (distinct from star). Loaded from the local pin set when the file changes.
  const [offline, setOffline] = useState(false);
  const [offlineBusy, setOfflineBusy] = useState(false);
  // Tracks the currently-shown file so an in-flight offline toggle can tell whether the
  // user has since navigated away (this component persists across file changes).
  const currentFileId = useRef(file?.id);
  currentFileId.current = file?.id;
  useEffect(() => {
    if (!file || file.kind === "folder") {
      setOffline(false);
      return;
    }
    let live = true;
    void isItemOffline(file, space).then((v) => live && setOffline(v));
    return () => {
      live = false;
    };
  }, [file?.id, file?.kind, space]);

  async function toggleOffline() {
    if (!file) return;
    const target = file; // capture — the user may navigate away mid-flight
    const next = !offline;
    setOffline(next); // optimistic
    setOfflineBusy(true);
    try {
      await setItemOffline(target, space, next);
    } catch {
      if (currentFileId.current === target.id) setOffline(!next); // rollback only if still on the same file
    } finally {
      if (currentFileId.current === target.id) setOfflineBusy(false);
    }
  }

  const isFolder = file?.kind === "folder";
  const full = mode === "full";
  const viewer = file && !isFolder ? findViewer(file.name, undefined, installedPluginIds) : undefined;
  const editable =
    viewer?.plugin === "markdown-editor" ||
    viewer?.plugin === "code-editor" ||
    viewer?.plugin === "univer-office";
  // A trusted first-party React viewer (e.g. the Model Editor canvas) renders in
  // process instead of the sandboxed iframe — the host looks it up by plugin id.
  const TrustedFileView = viewer ? PLUGIN_UI[viewer.plugin]?.FileView : undefined;
  // Layout hints come straight from the viewer's manifest contribution, so the
  // host carries no per-plugin knowledge. `fill` gives the viewer a real box
  // instead of auto-growing to content; `immersive` makes a full-screen viewer
  // take over the surface — dropping the metadata sidebar, the prev/next arrows
  // and the centred max-width cap, and yielding the arrow keys to the canvas.
  const fillViewer = !!viewer?.fill;
  const fullBleed = full && !!viewer?.immersive;

  // The panel isn't a modal (in split mode the list stays usable), so it owns its own
  // keyboard shortcuts: Escape closes it, and the arrow keys step to the previous/next
  // file in the list (up/down while docked, left/right in full screen — both axes work
  // either way). Skipped while a share dialog is layered on top, and while typing in a
  // field (description, tags, comments) so arrows still move the caret there.
  useEffect(() => {
    if (!file || shareOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      // An immersive full-screen viewer owns its own arrow keys (e.g. canvas
      // nudging) and hides the on-screen nav arrows, so don't steal them here.
      if (fullBleed) return;
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        if (!onPrev) return;
        e.preventDefault();
        onPrev();
      } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        if (!onNext) return;
        e.preventDefault();
        onNext();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [file, shareOpen, onClose, onPrev, onNext, fullBleed]);

  if (!file) return null;

  const viewerNode = TrustedFileView ? (
    <Suspense
      fallback={<div className="grid h-full min-h-[200px] place-items-center text-sm text-muted-foreground">Loading…</div>}
    >
      <TrustedFileView key={`${file.id}:${contentNonce}`} fileId={file.id} fileName={file.name} onSaved={onSaved} />
    </Suspense>
  ) : viewer ? (
    <PluginViewer
      key={`${file.id}:${contentNonce}`}
      file={{ source: viewer.source, name: file.name, url: contentUrl(file.id), spaceId: space }}
      fill={fillViewer}
      onSaved={onSaved}
      onSaveContent={editable ? (text) => saveFileVersion(file.id, text) : undefined}
    />
  ) : (
    <div
      className="grid h-52 place-items-center rounded-lg border-2 border-dashed text-center"
      style={{ borderColor: `hsl(${FILE_KIND_COLOR[file.kind]} / 0.4)` }}
    >
      <div className="flex flex-col items-center gap-2 text-muted-foreground">
        <FileIcon kind={file.kind} size={48} />
        <span className="text-[13px]">No viewer installed for this file type</span>
      </div>
    </div>
  );

  const details = (
    <>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4">
        <Detail label="Type">{file.kind}</Detail>
        <Detail label="Size">
          <span className="font-mono">{file.size}</span>
        </Detail>
        <Detail label="Modified">
          <span className="font-mono">{file.modified}</span>
        </Detail>
        <Detail label="Owner">{file.owner ?? "Unknown"}</Detail>
        <Detail label="Shared with">
          {file.sharedWith?.length ? <AvatarGroup people={file.sharedWith} /> : "Only you"}
        </Detail>
        <Detail label="Location">
          <span className="flex items-center gap-1.5">
            <Icon name="cloud" size={14} className="text-muted-foreground" />
            {file.location ?? STORAGE.label}
          </span>
        </Detail>
        {file.labels && file.labels.length > 0 && (
          <Detail label="Labels">
            <span className="flex flex-wrap gap-1.5">
              {file.labels.map((l) => (
                <span
                  key={l}
                  className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11.5px] font-medium text-primary"
                >
                  <Icon name="tag" size={11} />
                  {l}
                </span>
              ))}
            </span>
          </Detail>
        )}
      </div>

      {!isFolder && (
        <div>
          <SectionLabel>Description</SectionLabel>
          <DescriptionEditor key={file.id} fileId={file.id} initial={file.description ?? ""} onSaved={onSaved} />
        </div>
      )}

      {!isFolder && (
        <div>
          <SectionLabel>Tags</SectionLabel>
          <TagEditor key={file.id} fileId={file.id} initial={file.tags ?? []} onSaved={onSaved} />
        </div>
      )}

      {!isFolder && file.processing && file.processing.length > 0 && <ProcessingLog entries={file.processing} />}

      {!isFolder && (
        <VersionHistory
          fileId={file.id}
          fileName={file.name}
          onRestored={() => {
            setContentNonce((n) => n + 1);
            onSaved?.();
          }}
        />
      )}

      {!isFolder && <Comments key={file.id} fileId={file.id} />}
    </>
  );

  return (
    <aside
      aria-label={`Preview: ${file.name}`}
      className={cn(
        "flex min-w-0 flex-col bg-background",
        full
          ? "fixed inset-0 z-50 animate-in fade-in duration-200"
          : "z-30 h-full border-l shadow-xl animate-in slide-in-from-right duration-300",
      )}
    >
      {!isFolder && (
        <ShareDialog target={{ kind: "file", fileId: file.id }} label={file.name} open={shareOpen} onOpenChange={setShareOpen} />
      )}

      <header className="flex items-center gap-3 border-b px-4 py-3">
        <FileIcon kind={file.kind} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{file.name}</div>
          <div className="font-mono text-[12px] text-muted-foreground">
            {file.size} · {file.modified}
          </div>
        </div>
        {!isFolder && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => downloadFile(file.id, file.name)}
            >
              <Icon name="download" size={14} /> Download
            </Button>
            <Button
              variant={offline ? "secondary" : "outline"}
              size="sm"
              className="gap-1.5"
              onClick={toggleOffline}
              disabled={offlineBusy}
              title={offline ? "Kept on this device — click to remove" : "Make available offline on this device"}
            >
              <Icon name={offline ? "circle-check" : "cloud"} size={14} /> Offline
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setShareOpen(true)}>
              <Icon name="share" size={14} /> Share
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleMode}
          title={full ? "Dock to the side" : "Open full screen"}
          aria-label={full ? "Dock to the side" : "Open full screen"}
        >
          <Icon name={full ? "minimize" : "maximize"} size={16} />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onClose} title="Close" aria-label="Close preview">
          <Icon name="x" size={16} />
        </Button>
      </header>

      {full ? (
        <div className="flex min-h-0 flex-1">
          <div
            className={cn(
              "relative min-w-0 flex-1 bg-muted/20",
              fullBleed ? "p-0" : "p-6",
              fillViewer ? "flex" : "overflow-auto",
            )}
          >
            {!fullBleed && onPrev && <NavArrow side="left" onClick={onPrev} />}
            {!fullBleed && onNext && <NavArrow side="right" onClick={onNext} />}
            <div className={cn("mx-auto w-full", !fullBleed && "max-w-[1100px]", fillViewer && "flex min-h-0 flex-1")}>
              {viewerNode}
            </div>
          </div>
          {!fullBleed && (
            <div className="flex w-[360px] shrink-0 flex-col gap-6 overflow-y-auto border-l px-6 py-5">{details}</div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-6 overflow-y-auto px-6 py-5">
          {fillViewer ? <div className="h-[70vh] min-h-0 shrink-0">{viewerNode}</div> : viewerNode}
          {details}
        </div>
      )}
    </aside>
  );
}
