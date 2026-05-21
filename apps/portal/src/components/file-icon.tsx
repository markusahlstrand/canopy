import {
  Folder,
  FileText,
  Image as ImageIcon,
  NotebookText,
  FileType,
  FileAudio,
  FileVideo,
  type LucideIcon,
} from "lucide-react";
import { FILE_KIND_COLOR, type FileKind } from "@/lib/mock-data";

const KIND_ICON: Record<FileKind, LucideIcon> = {
  folder: Folder,
  pdf: FileText,
  image: ImageIcon,
  note: NotebookText,
  doc: FileType,
  audio: FileAudio,
  video: FileVideo,
};

export function FileIcon({ kind, size = 32 }: { kind: FileKind; size?: number }) {
  const Icon = KIND_ICON[kind];
  const color = FILE_KIND_COLOR[kind];
  return (
    <div
      className="grid place-items-center rounded-md"
      style={{
        width: size,
        height: size,
        background: `hsl(${color} / 0.12)`,
        color: `hsl(${color})`,
        flex: "none",
      }}
    >
      <Icon size={size * 0.5} strokeWidth={1.75} />
    </div>
  );
}
