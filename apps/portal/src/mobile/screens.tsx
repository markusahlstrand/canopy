import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/lib/icons";
import { FileIcon } from "@/components/file-icon";
import { PersonAvatar, AvatarGroup } from "@/components/person-avatar";
import { cn } from "@/lib/utils";
import { listFiles } from "@/lib/api";
import { STORAGE, type FileItem, type FileKind } from "@/lib/mock-data";

function SectionHeader({ title, onMore }: { title: string; onMore?: () => void }) {
  return (
    <div className="mb-2.5 flex items-baseline">
      <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
      <div className="flex-1" />
      {onMore && (
        <button onClick={onMore} className="text-[13px] font-medium text-primary">
          See all
        </button>
      )}
    </div>
  );
}

function SearchPill({ label, compact }: { label: string; compact?: boolean }) {
  return (
    <div
      className={cn(
        "flex w-full items-center gap-2.5 border bg-muted px-3.5 text-muted-foreground",
        compact ? "h-10 rounded-xl text-[14px]" : "h-11 rounded-2xl text-[14.5px]",
      )}
    >
      <Icon name="search" size={compact ? 16 : 17} />
      <span className="truncate">{label}</span>
    </div>
  );
}

function MFileRow({ file, onClick }: { file: FileItem; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 border-b px-[18px] py-3 text-left last:border-0">
      <FileIcon kind={file.kind} size={40} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[14.5px] font-medium">{file.name}</span>
          {file.starred && <Icon name="star" size={11} className="shrink-0 fill-warning text-warning" />}
        </div>
        <div className="mt-1 flex items-center gap-2 font-mono text-[11.5px] text-muted-foreground">
          <span>{file.modified}</span>
          <span className="opacity-50">·</span>
          <span>{file.size}</span>
          {file.sharedWith && file.sharedWith.length > 0 && (
            <>
              <span className="opacity-50">·</span>
              <AvatarGroup people={file.sharedWith} max={3} />
            </>
          )}
        </div>
      </div>
      <Icon name="chevron-right" size={14} className="shrink-0 text-muted-foreground" />
    </button>
  );
}

// ── Home ────────────────────────────────────────────────────────────────

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

const ACTIVITY = [
  { who: "Daniel", action: "added", target: "House lease 2024.pdf", when: "2h" },
  { who: "Lily", action: "commented on", target: "Maya birthday — 7.heic", when: "5h" },
  { who: "Maya", action: "renamed", target: "Family photos", when: "Yesterday" },
];

export function HomeScreen({
  userName,
  onOpenFile,
  onNav,
}: {
  userName: string;
  onOpenFile: (f: FileItem) => void;
  onNav: (view: string) => void;
}) {
  const [recent, setRecent] = useState<FileItem[]>([]);
  useEffect(() => {
    listFiles("").then((items) => setRecent(items.slice(0, 6))).catch(() => setRecent([]));
  }, []);

  return (
    <div className="px-[18px] pt-2.5">
      {/* greeting */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-muted-foreground">{greeting()}</div>
          <div className="truncate text-[28px] font-semibold leading-tight tracking-tight">{userName}</div>
        </div>
        <div className="relative">
          <PersonAvatar name={userName} size="lg" />
          <span className="absolute -right-0.5 -top-0.5 size-[11px] rounded-full bg-primary ring-2 ring-background" />
        </div>
      </div>

      <div className="mb-5">
        <SearchPill label="Search files, folders, notes…" />
      </div>

      {/* stat cards */}
      <div className="mb-6 grid grid-cols-2 gap-2.5">
        <div className="flex flex-col gap-1 rounded-2xl border bg-card p-3.5">
          <div className="flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
            <Icon name="cloud" size={13} className="text-primary" /> Storage
          </div>
          <div className="text-[20px] font-semibold tracking-tight">{STORAGE.used}</div>
          <div className="font-mono text-[12px] text-muted-foreground">of {STORAGE.total} · {STORAGE.percent}%</div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${STORAGE.percent}%` }} />
          </div>
        </div>
        <div className="flex flex-col gap-1 rounded-2xl border bg-card p-3.5">
          <div className="flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
            <Icon name="users" size={13} style={{ color: "hsl(327 60% 55%)" }} /> Family
          </div>
          <div className="text-[20px] font-semibold tracking-tight">4 members</div>
          <div className="text-[12px] text-muted-foreground">62 shared files</div>
        </div>
      </div>

      {/* recent */}
      <SectionHeader title="Recent" onMore={() => onNav("drive")} />
      <div className="-mx-[18px] mb-6 flex gap-2.5 overflow-x-auto px-[18px] pb-1.5 [scrollbar-width:none]">
        {recent.map((f) => (
          <button
            key={f.id}
            onClick={() => onOpenFile(f)}
            className="w-[140px] shrink-0 rounded-2xl border bg-card p-3 text-left"
          >
            <FileIcon kind={f.kind} size={36} />
            <div className="mt-3 line-clamp-2 min-h-[34px] text-[13px] font-medium leading-snug">{f.name}</div>
            <div className="mt-1.5 font-mono text-[11px] text-muted-foreground">{f.modified}</div>
          </button>
        ))}
        {recent.length === 0 && <div className="py-4 text-[13px] text-muted-foreground">No recent files.</div>}
      </div>

      {/* plugins */}
      <SectionHeader title="Plugins" />
      <div className="mb-6 flex flex-col gap-2">
        <PluginRow color="212 92% 50%" icon="calendar" label="Calendar" hint="3 events today" badge="3" onClick={() => onNav("plugins")} />
        <PluginRow color="38 92% 50%" icon="check-square" label="Tasks" hint="4 due this week" badge="4" dot onClick={() => onNav("plugins")} />
        <button onClick={() => onNav("plugins")} className="flex items-center gap-2.5 rounded-xl border border-dashed px-3.5 py-2.5 text-[13.5px] font-medium text-muted-foreground">
          <Icon name="package" size={16} /> Browse plugin store
        </button>
      </div>

      {/* activity */}
      <SectionHeader title="Activity" />
      <div className="flex flex-col">
        {ACTIVITY.map((a, i) => (
          <div key={i} className="flex items-center gap-2.5 border-b py-2.5 last:border-0">
            <PersonAvatar name={a.who} size="md" />
            <div className="flex-1 text-[13px] leading-snug">
              <span className="font-semibold">{a.who}</span>{" "}
              <span className="text-muted-foreground">{a.action}</span>{" "}
              <span className="font-medium">{a.target}</span>
            </div>
            <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">{a.when}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PluginRow({
  color,
  icon,
  label,
  hint,
  badge,
  dot,
  onClick,
}: {
  color: string;
  icon: string;
  label: string;
  hint: string;
  badge?: string;
  dot?: boolean;
  onClick?: () => void;
}) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-xl border bg-card px-3.5 py-3 text-left">
      <span className="grid size-9 shrink-0 place-items-center rounded-[10px]" style={{ background: `hsl(${color} / 0.14)`, color: `hsl(${color})` }}>
        <Icon name={icon} size={17} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-semibold">{label}</span>
        <span className="block text-[12.5px] text-muted-foreground">{hint}</span>
      </span>
      {dot && <span className="size-[7px] rounded-full bg-primary" />}
      {badge && (
        <span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[11.5px] font-semibold text-foreground/70">{badge}</span>
      )}
      <Icon name="chevron-right" size={14} className="text-muted-foreground" />
    </button>
  );
}

// ── Drive ───────────────────────────────────────────────────────────────

const CHIPS: { id: string; label: string; kinds?: FileKind[]; folders?: boolean }[] = [
  { id: "all", label: "All" },
  { id: "folders", label: "Folders", folders: true },
  { id: "photos", label: "Photos", kinds: ["image"] },
  { id: "docs", label: "PDFs & docs", kinds: ["pdf", "doc"] },
  { id: "notes", label: "Notes", kinds: ["note"] },
];

export function DriveScreen({ onOpenFile }: { onOpenFile: (f: FileItem) => void }) {
  const [path, setPath] = useState("");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    listFiles(path).then(setFiles).catch((e: Error) => {
      setFiles([]);
      setError(e.message);
    });
  }, [path]);

  const filtered = useMemo(() => {
    const chip = CHIPS.find((c) => c.id === filter);
    if (!chip || chip.id === "all") return files;
    return files.filter((f) => (chip.folders ? f.kind === "folder" : chip.kinds?.includes(f.kind)));
  }, [files, filter]);

  const segments = path.split("/").filter(Boolean);

  function open(f: FileItem) {
    if (f.kind === "folder" && f.path != null) setPath(f.path);
    else onOpenFile(f);
  }

  return (
    <div>
      <div className="px-[18px] pb-3.5 pt-2">
        <div className="mb-2 flex items-center gap-1 whitespace-nowrap text-[12.5px] font-medium text-muted-foreground">
          <Icon name="cloud" size={12} className="text-primary" />
          <button onClick={() => setPath("")} className="shrink-0">{STORAGE.label}</button>
          <Icon name="chevron-right" size={11} />
          <span className="shrink-0 font-semibold text-foreground">{segments[segments.length - 1] ?? "My Drive"}</span>
        </div>
        <h1 className="text-[30px] font-semibold tracking-tight">{segments[segments.length - 1] ?? "My Drive"}</h1>
        <div className="mt-1 font-mono text-[13px] text-muted-foreground">{filtered.length} items</div>
      </div>

      <div className="px-[18px] pb-3">
        <SearchPill label="Search My Drive" compact />
      </div>

      <div className="flex gap-2 overflow-x-auto px-[18px] pb-3.5 [scrollbar-width:none]">
        {CHIPS.map((c) => {
          const active = filter === c.id;
          return (
            <button
              key={c.id}
              onClick={() => setFilter(c.id)}
              className={cn(
                "h-8 shrink-0 whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium transition-colors",
                active ? "bg-primary text-primary-foreground" : "border bg-card text-foreground/80",
              )}
            >
              {c.label}
            </button>
          );
        })}
      </div>

      {error ? (
        <div className="mx-[18px] rounded-xl border border-dashed p-6 text-center text-[13px] text-muted-foreground">
          Couldn't reach the storage API.
        </div>
      ) : (
        <div className="border-y bg-card">
          {filtered.map((f) => (
            <MFileRow key={f.id} file={f} onClick={() => open(f)} />
          ))}
          {filtered.length === 0 && <div className="px-[18px] py-8 text-center text-[13px] text-muted-foreground">Nothing here.</div>}
        </div>
      )}
    </div>
  );
}

// ── Family ──────────────────────────────────────────────────────────────

const FAMILY = [
  { name: "Maya", role: "You", storage: "5.2 GB" },
  { name: "Daniel", role: "Partner", storage: "4.1 GB" },
  { name: "Lily", role: "Kid · 9", storage: "2.4 GB" },
  { name: "Nora", role: "Kid · 12", storage: "0.7 GB" },
];

export function FamilyScreen({ onOpenFile }: { onOpenFile: (f: FileItem) => void }) {
  const [shared, setShared] = useState<FileItem[]>([]);
  useEffect(() => {
    listFiles("").then((items) => setShared(items.slice(0, 6))).catch(() => setShared([]));
  }, []);

  return (
    <div>
      <div className="px-[18px] pb-4 pt-2">
        <h1 className="text-[30px] font-semibold tracking-tight">Family</h1>
        <div className="mt-1 text-[13px] text-muted-foreground">4 members · 62 shared files</div>
      </div>

      <div className="-mx-[18px] mb-6 flex gap-3 overflow-x-auto px-[18px] [scrollbar-width:none]">
        {FAMILY.map((p) => (
          <div key={p.name} className="flex w-[110px] shrink-0 flex-col items-center gap-2 rounded-2xl border bg-card p-3.5 text-center">
            <PersonAvatar name={p.name} size="lg" className="size-[52px] text-base" />
            <div className="text-[13.5px] font-semibold">{p.name}</div>
            <div className="-mt-1 text-[11px] text-muted-foreground">{p.role}</div>
            <div className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground">{p.storage}</div>
          </div>
        ))}
        <button className="flex w-[110px] shrink-0 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed p-3.5 text-muted-foreground">
          <span className="grid size-[52px] place-items-center rounded-full bg-muted">
            <Icon name="plus" size={22} />
          </span>
          <span className="text-[12.5px] font-medium">Invite</span>
        </button>
      </div>

      <div className="px-[18px] pb-2">
        <SectionHeader title="Shared with family" />
      </div>
      <div className="border-y bg-card">
        {shared.map((f) => (
          <MFileRow key={f.id} file={f} onClick={() => onOpenFile(f)} />
        ))}
      </div>
    </div>
  );
}

// ── Plugins ─────────────────────────────────────────────────────────────

const STORE = [
  { color: "327 60% 55%", icon: "hash", label: "Notes", tagline: "Markdown notes synced with files." },
  { color: "248 60% 56%", icon: "database", label: "Budgets", tagline: "Track shared household spending." },
  { color: "190 70% 42%", icon: "globe", label: "Bookmarks", tagline: "Save links the whole family can read." },
  { color: "20 85% 52%", icon: "archive", label: "Receipts", tagline: "Scan & file receipts with OCR." },
];

export function PluginsScreen() {
  return (
    <div>
      <div className="px-[18px] pb-4 pt-2">
        <h1 className="text-[30px] font-semibold tracking-tight">Plugins</h1>
        <div className="mt-1 text-[13px] text-muted-foreground">Plug in only what your family will actually use.</div>
      </div>

      <div className="px-[18px] pb-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground">Installed</div>
      <div className="mb-6 flex flex-col gap-2.5 px-[18px]">
        <div className="rounded-2xl border bg-card p-3.5">
          <PluginCardHead color="212 92% 50%" icon="calendar" label="Calendar" tagline="Family events synced with notes & files." />
          <div className="mt-3 flex gap-2">
            {[
              { t: "9 AM", s: "Lily violin" },
              { t: "1 PM", s: "Standup" },
              { t: "6 PM", s: "Family dinner" },
            ].map((p) => (
              <div key={p.t} className="min-w-0 flex-1 rounded-[10px] bg-muted px-2.5 py-2">
                <div className="font-mono text-[10.5px] font-semibold" style={{ color: "hsl(212 92% 40%)" }}>{p.t}</div>
                <div className="mt-0.5 truncate text-[12px] font-medium">{p.s}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border bg-card p-3.5">
          <PluginCardHead color="38 92% 50%" icon="check-square" label="Tasks" tagline="Shared to-do list — who's doing what." />
          <div className="mt-3 flex flex-col gap-1.5">
            {[
              { label: "Renew home insurance", who: "Maya", due: "Today", high: true },
              { label: "Schedule Lily's checkup", who: "Daniel", due: "Tomorrow" },
              { label: "Buy gift for Nora", who: "Maya", due: "May 18" },
            ].map((t, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="size-4 shrink-0 rounded-[5px] border-[1.5px]" />
                <span className="flex-1 text-[13px] font-medium">{t.label}</span>
                <span className={cn("font-mono text-[11.5px]", t.high ? "font-semibold text-destructive" : "text-muted-foreground")}>{t.due}</span>
                <PersonAvatar name={t.who} size="xs" />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="px-[18px] pb-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground">From the store</div>
      <div className="flex flex-col gap-2.5 px-[18px]">
        {STORE.map((s) => (
          <div key={s.label} className="flex items-center gap-3 rounded-2xl border bg-card p-3">
            <span className="grid size-[38px] shrink-0 place-items-center rounded-[11px]" style={{ background: `hsl(${s.color} / 0.14)`, color: `hsl(${s.color})` }}>
              <Icon name={s.icon} size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold">{s.label}</div>
              <div className="text-[12px] text-muted-foreground">{s.tagline}</div>
            </div>
            <button className="h-7 rounded-full bg-primary px-3 text-[12.5px] font-semibold text-primary-foreground">Install</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function PluginCardHead({ color, icon, label, tagline }: { color: string; icon: string; label: string; tagline: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-[42px] shrink-0 place-items-center rounded-xl" style={{ background: `hsl(${color} / 0.14)`, color: `hsl(${color})` }}>
        <Icon name={icon} size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold">{label}</div>
        <div className="text-[12.5px] text-muted-foreground">{tagline}</div>
      </div>
      <Icon name="more" size={16} className="text-muted-foreground" />
    </div>
  );
}
