import { useState } from "react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ShareDialog } from "@/components/share-dialog";
import { Icon } from "@/lib/icons";
import { FileIcon } from "@/components/file-icon";
import { PersonAvatar } from "@/components/person-avatar";
import { PluginViewer } from "@/components/plugin-viewer";
import { VersionHistory } from "@/components/file-preview";
import { findViewer } from "@/plugins/viewers";
import { cn } from "@/lib/utils";
import { FILE_KIND_COLOR, STORAGE, type FileItem } from "@/lib/mock-data";
import { contentUrl, saveFileVersion } from "@/lib/api";

function Handle() {
  return <div className="mx-auto mt-2 mb-1 h-1.5 w-9 shrink-0 rounded-full bg-border" />;
}

const NEW_ITEMS: { icon: string; label: string; sub: string; color: string; action?: string }[] = [
  { icon: "upload", label: "Upload files", sub: "From your phone", color: "145 33% 36%", action: "upload" },
  { icon: "image", label: "Photo or video", sub: "From camera roll", color: "38 92% 50%" },
  { icon: "folder", label: "New folder", sub: "Create in My Drive", color: "212 70% 48%" },
  { icon: "note", label: "New note", sub: "Markdown · auto-synced", color: "212 92% 50%", action: "note" },
  { icon: "file-text", label: "Scan document", sub: "Receipt, paper, mail", color: "248 60% 56%" },
];

export function NewActionSheet({
  open,
  onOpenChange,
  onUpload,
  onNewNote,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpload: () => void;
  onNewNote: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="gap-0 rounded-t-[20px] p-0 pb-8">
        <Handle />
        <div className="px-[18px] pb-3 pt-1">
          <div className="text-[17px] font-semibold tracking-tight">New</div>
          <div className="mt-0.5 text-[12.5px] text-muted-foreground">
            Add to <span className="font-medium text-foreground/80">My Drive</span>
          </div>
        </div>
        <div className="flex flex-col px-[18px]">
          {NEW_ITEMS.map((it) => (
            <button
              key={it.label}
              onClick={() => {
                onOpenChange(false);
                if (it.action === "upload") onUpload();
                else if (it.action === "note") onNewNote();
              }}
              className="flex items-center gap-3.5 border-b py-3 text-left last:border-0"
            >
              <span
                className="grid size-10 shrink-0 place-items-center rounded-xl"
                style={{ background: `hsl(${it.color} / 0.14)`, color: `hsl(${it.color})` }}
              >
                <Icon name={it.icon} size={19} />
              </span>
              <span className="flex-1">
                <span className="block text-[15px] font-medium">{it.label}</span>
                <span className="block text-[12.5px] text-muted-foreground">{it.sub}</span>
              </span>
              <Icon name="chevron-right" size={14} className="text-muted-foreground" />
            </button>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ActionTile({ icon, label, active, onClick }: { icon: string; label: string; active?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-1.5 rounded-xl py-3",
        active ? "bg-warning/15 text-warning" : "bg-muted/70 text-foreground/80",
      )}
    >
      <Icon name={icon} size={18} />
      <span className="text-[11.5px] font-medium">{label}</span>
    </button>
  );
}

function DetailRow({ label, value, last }: { label: string; value: React.ReactNode; last?: boolean }) {
  return (
    <div className={cn("flex items-center py-2.5 text-[13px]", !last && "border-b")}>
      <span className="w-[92px] text-[12.5px] text-muted-foreground">{label}</span>
      <span className="flex-1 text-right font-medium">{value}</span>
    </div>
  );
}

const COMMENTS = [
  { who: "Daniel", when: "2h", body: "Saved a copy of this to the lease folder — same as last year's." },
  { who: "Lily", when: "Yesterday", body: "Can we look at this together tonight?" },
];

export function FileDetailSheet({
  file,
  open,
  onOpenChange,
  installedPluginIds,
}: {
  file: FileItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Plugins active for this user — gates store-listed viewers (e.g. code-editor). */
  installedPluginIds?: string[];
}) {
  const [shareOpen, setShareOpen] = useState(false);
  // Bumped after a restore to remount the viewer so it refetches the now-current
  // content (parity with the desktop preview's contentNonce).
  const [contentNonce, setContentNonce] = useState(0);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[92dvh] gap-0 rounded-t-[20px] p-0">
        <Handle />
        {file && (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-[18px] pb-8">
            {file.kind !== "folder" && (
              <ShareDialog target={{ kind: "file", fileId: file.id }} label={file.name} open={shareOpen} onOpenChange={setShareOpen} />
            )}
            {/* preview */}
            {(() => {
              const viewer = file.kind !== "folder" ? findViewer(file.name, undefined, installedPluginIds) : undefined;
              const editable =
                viewer?.plugin === "markdown-editor" ||
                viewer?.plugin === "code-editor" ||
                viewer?.plugin === "univer-office";
              return viewer ? (
                <PluginViewer
                  key={`${file.id}:${contentNonce}`}
                  file={{ source: viewer.source, name: file.name, url: contentUrl(file.id) }}
                  className="mt-1"
                  onSaveContent={editable ? (text) => saveFileVersion(file.id, text) : undefined}
                />
              ) : (
                <div
                  className="grid place-items-center rounded-2xl border border-dashed py-8 text-center"
                  style={{
                    background: `hsl(${FILE_KIND_COLOR[file.kind]} / 0.06)`,
                    borderColor: `hsl(${FILE_KIND_COLOR[file.kind]} / 0.35)`,
                    color: `hsl(${FILE_KIND_COLOR[file.kind]})`,
                  }}
                >
                  <FileIcon kind={file.kind} size={64} />
                  <div className="mt-2.5 text-[11.5px] text-muted-foreground">Preview</div>
                </div>
              );
            })()}

            {/* title + meta */}
            <div className="pt-3.5">
              <div className="text-[18px] font-semibold tracking-tight">{file.name}</div>
              <div className="mt-1 font-mono text-[12.5px] text-muted-foreground">
                {file.kind.toUpperCase()} · {file.size} · {file.modified}
              </div>
            </div>

            {/* action grid */}
            <div className="mt-3 grid grid-cols-4 gap-2">
              <ActionTile icon="share" label="Share" onClick={() => file.kind !== "folder" && setShareOpen(true)} />
              <ActionTile
                icon="download"
                label="Save"
                onClick={() => file.kind !== "folder" && window.open(contentUrl(file.id), "_blank")}
              />
              <ActionTile icon="star" label={file.starred ? "Starred" : "Star"} active={file.starred} />
              <ActionTile icon="more" label="More" />
            </div>

            {/* details */}
            <div className="mt-4 rounded-2xl bg-muted/60 px-3.5">
              <DetailRow
                label="Owner"
                value={
                  <span className="inline-flex items-center gap-1.5">
                    <PersonAvatar name="Maya" size="xs" /> Maya Chen
                  </span>
                }
              />
              <DetailRow
                label="Location"
                value={
                  <span className="inline-flex items-center gap-1.5 text-primary">
                    <Icon name="cloud" size={13} /> {STORAGE.label}
                  </span>
                }
              />
              <DetailRow label="Modified" value={<span className="font-mono">{file.modified}</span>} />
              <DetailRow label="Size" value={<span className="font-mono">{file.size}</span>} last />
            </div>

            {/* shared with */}
            <div className="mb-2 mt-4 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
              Shared with
            </div>
            {file.sharedWith?.length ? (
              <div className="flex flex-col gap-1.5">
                {file.sharedWith.map((n) => (
                  <div key={n} className="flex items-center gap-2.5 rounded-xl border px-3 py-2">
                    <PersonAvatar name={n} size="md" />
                    <span className="flex-1 text-[13.5px] font-medium">{n}</span>
                    <span className="font-mono text-[11.5px] text-muted-foreground">
                      {n === "Maya" ? "Owner" : "Can edit"}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[13px] text-muted-foreground">Only you can see this file.</div>
            )}

            {/* version history (hidden when there's none, e.g. folders / read-only mounts) */}
            {file.kind !== "folder" && (
              <VersionHistory fileId={file.id} onRestored={() => setContentNonce((n) => n + 1)} className="mt-4" />
            )}

            {/* comments */}
            <div className="mb-2 mt-4 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
              Comments
            </div>
            <div className="flex flex-col">
              {COMMENTS.map((c, i) => (
                <div key={i} className="flex gap-2.5 border-b py-2.5 last:border-0">
                  <PersonAvatar name={c.who} size="md" />
                  <div className="flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[13px] font-semibold">{c.who}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">{c.when}</span>
                    </div>
                    <p className="mt-0.5 text-[13px] leading-snug">{c.body}</p>
                  </div>
                </div>
              ))}
            </div>
            <button className="mt-3 rounded-xl border bg-muted/70 px-3.5 py-3 text-left text-[13px] text-muted-foreground">
              Add a comment…
            </button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
