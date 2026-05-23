import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ShareDialog } from "@/components/share-dialog";
import { Icon } from "@/lib/icons";
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
  setDescription as apiSetDescription,
  setTags as apiSetTags,
  type Comment,
  type FileVersion,
} from "@/lib/api";
import { FILE_KIND_COLOR, STORAGE, CURRENT_USER, type FileItem } from "@/lib/mock-data";

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

/** A file's saved versions, newest first. Older entries can be restored. */
function VersionHistory({ fileId, onRestored }: { fileId: string; onRestored: () => void }) {
  const [versions, setVersions] = useState<FileVersion[] | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
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

  return (
    <div>
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
              {i !== 0 && (
                <Button variant="ghost" size="sm" disabled={busy != null} onClick={() => restore(v.id)}>
                  {busy === v.id ? "Restoring…" : "Restore"}
                </Button>
              )}
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
          <PersonAvatar name={CURRENT_USER.name} size="md" />
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

export function FilePreview({
  file,
  onClose,
  onSaved,
  space,
}: {
  file: FileItem | null;
  onClose: () => void;
  onSaved?: () => void;
  /** The space the file lives in (so a saved version's blob lands there). */
  space?: string;
}) {
  const [shareOpen, setShareOpen] = useState(false);
  // Bumped after a restore to remount the viewer so it refetches the current content.
  const [contentNonce, setContentNonce] = useState(0);
  return (
    <Sheet open={!!file} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[640px] max-w-[92vw] gap-0 sm:max-w-[640px]">
        {file && (
          <>
            {file.kind !== "folder" && (
              <ShareDialog fileId={file.id} fileName={file.name} open={shareOpen} onOpenChange={setShareOpen} />
            )}
            <SheetHeader className="flex-row items-center gap-3 border-b space-y-0">
              <FileIcon kind={file.kind} />
              <div className="min-w-0 flex-1">
                <SheetTitle className="truncate">{file.name}</SheetTitle>
                <div className="font-mono text-[12px] text-muted-foreground">
                  {file.size} · {file.modified}
                </div>
              </div>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => window.open(contentUrl(file.id), "_blank")}>
                <Icon name="download" size={14} /> Download
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setShareOpen(true)}>
                <Icon name="share" size={14} /> Share
              </Button>
            </SheetHeader>

            <div className="flex flex-col gap-6 overflow-y-auto px-6 py-5">
              {(() => {
                const viewer = file.kind !== "folder" ? findViewer(file.name) : undefined;
                const editable = viewer?.plugin === "markdown-editor";
                return viewer ? (
                  <PluginViewer
                    key={`${file.id}:${contentNonce}`}
                    file={{ source: viewer.source, name: file.name, url: contentUrl(file.id) }}
                    onSaved={onSaved}
                    onSaveContent={editable ? (text) => saveFileVersion(file.id, text, undefined, space) : undefined}
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
              })()}

              <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                <Detail label="Type">{file.kind}</Detail>
                <Detail label="Size">
                  <span className="font-mono">{file.size}</span>
                </Detail>
                <Detail label="Modified">
                  <span className="font-mono">{file.modified}</span>
                </Detail>
                <Detail label="Owner">{file.owner ?? CURRENT_USER.name}</Detail>
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

              {file.kind !== "folder" && (
                <div>
                  <SectionLabel>Description</SectionLabel>
                  <DescriptionEditor key={file.id} fileId={file.id} initial={file.description ?? ""} onSaved={onSaved} />
                </div>
              )}

              {file.kind !== "folder" && (
                <div>
                  <SectionLabel>Tags</SectionLabel>
                  <TagEditor key={file.id} fileId={file.id} initial={file.tags ?? []} onSaved={onSaved} />
                </div>
              )}

              {file.kind !== "folder" && (
                <VersionHistory
                  fileId={file.id}
                  onRestored={() => {
                    setContentNonce((n) => n + 1);
                    onSaved?.();
                  }}
                />
              )}

              {file.kind !== "folder" && <Comments key={file.id} fileId={file.id} />}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
