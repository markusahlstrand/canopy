import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ShareDialog } from "@/components/share-dialog";
import { Icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { FileIcon } from "@/components/file-icon";
import { AvatarGroup, PersonAvatar } from "@/components/person-avatar";
import { PluginViewer } from "@/components/plugin-viewer";
import { findViewer } from "@/plugins/viewers";
import {
  addComment,
  contentUrl,
  deleteComment,
  fetchMe,
  humanSize,
  listComments,
  listVersions,
  restoreVersion,
  saveFileVersion,
  setVersionKeep,
  versionContentUrl,
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
  onRestored,
  className,
}: {
  fileId: string;
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
                    onClick={() => window.open(versionContentUrl(fileId, v.id), "_blank")}
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

export function FilePreview({
  file,
  mode,
  onToggleMode,
  onClose,
  onSaved,
  installedPluginIds,
}: {
  file: FileItem | null;
  /** "split" docks beside the (still-interactive) file list; "full" covers the viewport. */
  mode: PreviewMode;
  onToggleMode: () => void;
  onClose: () => void;
  onSaved?: () => void;
  /** Plugins active for this user — gates store-listed viewers (e.g. code-editor). */
  installedPluginIds?: string[];
}) {
  const [shareOpen, setShareOpen] = useState(false);
  // Bumped after a restore to remount the viewer so it refetches the current content.
  const [contentNonce, setContentNonce] = useState(0);

  // The panel isn't a modal (in split mode the list stays usable), so it owns its
  // own Escape-to-close. Skipped while a share dialog is layered on top of it.
  useEffect(() => {
    if (!file || shareOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [file, shareOpen, onClose]);

  if (!file) return null;

  const isFolder = file.kind === "folder";
  const full = mode === "full";
  const viewer = !isFolder ? findViewer(file.name, undefined, installedPluginIds) : undefined;
  const editable =
    viewer?.plugin === "markdown-editor" ||
    viewer?.plugin === "code-editor" ||
    viewer?.plugin === "univer-office";
  // Images fill the available area instead of auto-growing the iframe to content
  // — the host gives them a real box (see layout below) and the viewer fits inside.
  const fillViewer = viewer?.plugin === "image-viewer";

  const viewerNode = viewer ? (
    <PluginViewer
      key={`${file.id}:${contentNonce}`}
      file={{ source: viewer.source, name: file.name, url: contentUrl(file.id) }}
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
              onClick={() => window.open(contentUrl(file.id), "_blank")}
            >
              <Icon name="download" size={14} /> Download
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
          <div className={cn("min-w-0 flex-1 bg-muted/20 p-6", fillViewer ? "flex" : "overflow-auto")}>
            <div className={cn("mx-auto w-full max-w-[1100px]", fillViewer && "flex min-h-0 flex-1")}>
              {viewerNode}
            </div>
          </div>
          <div className="flex w-[360px] shrink-0 flex-col gap-6 overflow-y-auto border-l px-6 py-5">{details}</div>
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
