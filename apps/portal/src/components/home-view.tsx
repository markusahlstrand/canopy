import type { PluginManifest } from "@canopy/core";
import { ChevronRight } from "lucide-react";
import { Icon } from "@/lib/icons";
import { FileIcon } from "@/components/file-icon";
import { PersonAvatar } from "@/components/person-avatar";
import { CURRENT_USER, STORAGE, type FileItem } from "@/lib/mock-data";

const ACTIVITY = [
  { who: "Daniel", action: "shared", target: "House lease 2024.pdf", time: "2h ago" },
  { who: "Lily", action: "uploaded", target: "Maya birthday — 7.heic", time: "5h ago" },
  { who: "Maya", action: "edited", target: "Trip planning.doc", time: "yesterday" },
  { who: "Nora", action: "commented on", target: "Family photos", time: "2d ago" },
];

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

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
  onOpenPlugin: (id: string) => void;
  onOpenFile: (f: FileItem) => void;
}

export function HomeView({ installed, files, onOpenPlugin, onOpenFile }: HomeViewProps) {
  const recent = files.slice(0, 4);
  return (
    <div className="flex flex-col gap-7">
      <div>
        <h1 className="text-[28px] font-semibold tracking-tight">
          {greeting()}, {CURRENT_USER.name.split(" ")[0]}.
        </h1>
        <p className="mt-1 text-muted-foreground">Here's what's happening across your family.</p>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <StatCard icon="my-drive" color="145 33% 36%" label="Files" value="84" sub="12 added this month" />
        <StatCard icon="family" color="212 70% 48%" label="Shared with family" value="38" sub="across 4 people" />
        <StatCard icon="plugin" color="262 60% 55%" label="Plugins installed" value={String(installed.length)} sub="2 with updates" />
        <StatCard icon="cloud" color="20 85% 52%" label="Storage used" value={STORAGE.used} sub={`of ${STORAGE.total} · ${STORAGE.percent}%`} />
      </div>

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
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Activity</div>
          <div className="flex flex-col">
            {ACTIVITY.map((a, i) => (
              <div key={i} className="flex items-center gap-2.5 border-b py-2.5 last:border-0">
                <PersonAvatar name={a.who} size="md" />
                <div className="min-w-0 flex-1 text-[13px]">
                  <span className="font-medium">{a.who}</span> {a.action}{" "}
                  <span className="font-medium">{a.target}</span>
                </div>
                <span className="font-mono text-[11.5px] text-muted-foreground">{a.time}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
