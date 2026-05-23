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
import { contentUrl, humanSize, listVersions, restoreVersion, saveFileVersion, type FileVersion } from "@/lib/api";
import { FILE_KIND_COLOR, STORAGE, CURRENT_USER, type FileItem } from "@/lib/mock-data";

const COMMENTS = [
  { who: "Daniel", time: "2 days ago", body: "Signed and uploaded the final version." },
  { who: "Maya", time: "yesterday", body: "Thanks — adding it to the house folder." },
];

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
                <VersionHistory
                  fileId={file.id}
                  onRestored={() => {
                    setContentNonce((n) => n + 1);
                    onSaved?.();
                  }}
                />
              )}

              <div>
                <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Comments
                </div>
                <div className="flex flex-col gap-4">
                  {COMMENTS.map((c, i) => (
                    <div key={i} className="flex gap-2.5">
                      <PersonAvatar name={c.who} size="md" />
                      <div className="min-w-0">
                        <div className="flex items-baseline gap-2">
                          <span className="text-[13px] font-medium">{c.who}</span>
                          <span className="text-[11.5px] text-muted-foreground">{c.time}</span>
                        </div>
                        <p className="text-[13.5px]">{c.body}</p>
                      </div>
                    </div>
                  ))}
                  <div className="flex items-center gap-2.5">
                    <PersonAvatar name={CURRENT_USER.name} size="md" />
                    <Input placeholder="Add a comment…" />
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
