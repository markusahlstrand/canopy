import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ShareDialog } from "@/components/share-dialog";
import { Icon } from "@/lib/icons";
import { FileIcon } from "@/components/file-icon";
import { AvatarGroup, PersonAvatar } from "@/components/person-avatar";
import { PluginViewer } from "@/components/plugin-viewer";
import { findViewer } from "@/plugins/viewers";
import { contentUrl, saveFileVersion } from "@/lib/api";
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
                    key={file.id}
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
                <Detail label="Owner">{CURRENT_USER.name}</Detail>
                <Detail label="Shared with">
                  {file.sharedWith?.length ? <AvatarGroup people={file.sharedWith} /> : "Only you"}
                </Detail>
                <Detail label="Location">
                  <span className="flex items-center gap-1.5">
                    <Icon name="cloud" size={14} className="text-muted-foreground" />
                    {STORAGE.label}
                  </span>
                </Detail>
              </div>

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
