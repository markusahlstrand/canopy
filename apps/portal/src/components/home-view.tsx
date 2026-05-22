import type { PluginManifest } from "@canopy/core";
import { ChevronRight } from "lucide-react";
import { Icon } from "@/lib/icons";
import { FileIcon } from "@/components/file-icon";
import { humanSize, type Overview, type SpaceView } from "@/lib/api";
import type { FileItem } from "@/lib/mock-data";

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** A pseudo-folder (a mounted space / "Shared with me") rather than a real file. */
const isPseudo = (f: FileItem) => f.id.startsWith("space:") || f.id === "__shared";

function StatCard({ icon, color, label, value, sub }: { icon: string; color: string; label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 grid size-9 place-items-center rounded-md" style={{ background: `hsl(${color} / 0.14)`, color: `hsl(${color})` }}>
        <Icon name={icon} size={18} />
      </div>
      <div className="text-[11.5px] text-muted-foreground">{label}</div>
      <div className="text-[22px] font-semibold">{value}</div>
      <div className="text-[12px] text-muted-foreground">{sub}</div>
    </div>
  );
}

interface HomeViewProps {
  installed: PluginManifest[];
  files: FileItem[];
  spaces: SpaceView[];
  overview: Overview;
  sharedCount: number;
  userName?: string;
  onOpenPlugin: (id: string) => void;
  onOpenFile: (f: FileItem) => void;
  onOpenSpace: (id: string) => void;
}

export function HomeView({
  installed,
  files,
  spaces,
  overview,
  sharedCount,
  userName,
  onOpenPlugin,
  onOpenFile,
  onOpenSpace,
}: HomeViewProps) {
  const first = (userName ?? "there").split(/[\s@]/)[0];
  const recent = files.filter((f) => f.kind !== "folder" && !isPseudo(f)).slice(0, 4);
  const groups = spaces.filter((s) => s.kind === "group");

  return (
    <div className="flex flex-col gap-7">
      <div>
        <h1 className="text-[28px] font-semibold tracking-tight">
          {greeting()}, {first}.
        </h1>
        <p className="mt-1 text-muted-foreground">Here's what's in your drive.</p>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <StatCard icon="my-drive" color="145 33% 36%" label="Files" value={String(overview.files)} sub="in My Drive" />
        <StatCard icon="cloud" color="20 85% 52%" label="Storage used" value={humanSize(overview.bytes)} sub={`${overview.files} file${overview.files === 1 ? "" : "s"}`} />
        <StatCard icon="users" color="212 70% 48%" label="Shared with me" value={String(sharedCount)} sub={sharedCount === 1 ? "file" : "files"} />
        <StatCard icon="plugin" color="262 60% 55%" label="Plugins" value={String(installed.length)} sub="installed" />
      </div>

      {recent.length > 0 && (
        <div>
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Pick up where you left off
          </div>
          <div className="grid grid-cols-4 gap-3">
            {recent.map((f) => (
              <button
                key={f.id}
                onClick={() => onOpenFile(f)}
                className="flex flex-col gap-2.5 rounded-lg border bg-card p-3.5 text-left transition-colors hover:bg-muted/50"
              >
                <FileIcon kind={f.kind} size={38} />
                <div className="truncate text-[13.5px] font-medium">{f.name}</div>
                <div className="font-mono text-[11.5px] text-muted-foreground">{f.modified}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-[1.4fr_1fr] gap-6">
        <div>
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Your plugins</div>
          <div className="flex flex-col gap-2">
            {installed.map((p) => (
              <button
                key={p.id}
                onClick={() => onOpenPlugin(p.id)}
                className="flex items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-muted/50"
              >
                <div className="grid size-9 place-items-center rounded-md" style={{ background: `hsl(${p.color} / 0.14)`, color: `hsl(${p.color})` }}>
                  <Icon name={p.icon ?? "plugin"} size={18} />
                </div>
                <div className="flex-1">
                  <div className="text-[13.5px] font-medium">{p.name}</div>
                  <div className="text-[12px] text-muted-foreground">{p.contributes?.store?.tagline}</div>
                </div>
                <ChevronRight size={16} className="text-muted-foreground" />
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Your spaces</div>
          <div className="flex flex-col gap-2">
            {groups.map((s) => (
              <button
                key={s.id}
                onClick={() => onOpenSpace(s.id)}
                className="flex items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-muted/50"
              >
                <div className="grid size-9 place-items-center rounded-md bg-primary/10 text-primary">
                  <Icon name="users" size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium">{s.name}</div>
                  <div className="text-[12px] capitalize text-muted-foreground">{s.role}</div>
                </div>
                <ChevronRight size={16} className="text-muted-foreground" />
              </button>
            ))}
            {groups.length === 0 && (
              <div className="rounded-lg border border-dashed p-4 text-center text-[13px] text-muted-foreground">
                No shared spaces yet. Create one from the sidebar to share with family.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
