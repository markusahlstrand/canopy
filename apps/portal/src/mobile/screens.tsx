import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/lib/icons";
import { FileIcon } from "@/components/file-icon";
import { PersonAvatar, AvatarGroup } from "@/components/person-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { listFiles, listShared, type Me, type SpaceView } from "@/lib/api";
import { PLUGIN_CATALOG, STORAGE, type FileItem, type FileKind } from "@/lib/mock-data";

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

// Tappable avatar that opens an account menu. Mirrors the desktop topbar: a real
// signed-in user gets name/email + Sign out; logged out gets a Log in entry and
// no fabricated persona (the green "online" dot is only shown when signed in).
function AccountMenu({
  userName,
  auth,
  onSignIn,
  onSignOut,
}: {
  userName: string;
  auth: Me;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  const user = auth.user;
  const name = user?.name ?? user?.email?.split("@")[0] ?? userName;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button aria-label="Account" className="relative shrink-0 rounded-full">
          <PersonAvatar name={user ? name : "?"} size="lg" />
          {user && (
            <span className="absolute -right-0.5 -top-0.5 size-[11px] rounded-full bg-primary ring-2 ring-background" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {user ? (
          <>
            <DropdownMenuLabel>
              <div className="font-medium">{name}</div>
              {user.email && (
                <div className="text-[12px] font-normal text-muted-foreground">{user.email}</div>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onSignOut}>
              <Icon name="log-out" size={15} /> Sign out
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem onClick={onSignIn} disabled={auth.offline}>
            <Icon name="log-out" size={15} className="rotate-180" /> Log in
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function HomeScreen({
  userName,
  auth,
  spaceCount,
  installed,
  refreshKey,
  onOpenFile,
  onNav,
  onSignIn,
  onSignOut,
}: {
  userName: string;
  auth: Me;
  spaceCount: number;
  installed: string[];
  refreshKey: number;
  onOpenFile: (f: FileItem) => void;
  onNav: (view: string) => void;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  const [recent, setRecent] = useState<FileItem[]>([]);
  useEffect(() => {
    listFiles("").then((items) => setRecent(items.slice(0, 6))).catch(() => setRecent([]));
  }, [refreshKey]);

  // Up to three installed apps to preview, resolved from the store catalog.
  const apps = installed
    .map((id) => PLUGIN_CATALOG.find((c) => c.id === id))
    .filter((c): c is (typeof PLUGIN_CATALOG)[number] => !!c)
    .slice(0, 3);

  return (
    <div className="px-[18px] pt-2.5">
      {/* greeting */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-muted-foreground">{greeting()}</div>
          <div className="truncate text-[28px] font-semibold leading-tight tracking-tight">{userName}</div>
        </div>
        <AccountMenu userName={userName} auth={auth} onSignIn={onSignIn} onSignOut={onSignOut} />
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
        <button
          onClick={() => onNav("spaces")}
          className="flex flex-col gap-1 rounded-2xl border bg-card p-3.5 text-left"
        >
          <div className="flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
            <Icon name="users" size={13} style={{ color: "hsl(327 60% 55%)" }} /> Spaces
          </div>
          <div className="text-[20px] font-semibold tracking-tight">
            {spaceCount} {spaceCount === 1 ? "space" : "spaces"}
          </div>
          <div className="text-[12px] text-muted-foreground">
            {spaceCount === 0 ? "Tap to create one" : "Shared with people"}
          </div>
        </button>
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

      {/* apps */}
      <SectionHeader title="Apps" onMore={() => onNav("apps")} />
      <div className="mb-6 flex flex-col gap-2">
        {apps.map((a) => (
          <AppRow key={a.id} color={a.color} icon={a.icon} label={a.label} hint={a.tagline} onClick={() => onNav("apps")} />
        ))}
        <button onClick={() => onNav("apps")} className="flex items-center gap-2.5 rounded-xl border border-dashed px-3.5 py-2.5 text-[13.5px] font-medium text-muted-foreground">
          <Icon name="grid" size={16} /> Browse apps
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

function AppRow({
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

// Top-level sources within Files — the same sub-views the desktop sidebar
// exposes (My Drive / Starred / Shared), here as a segmented control.
type Source = "drive" | "starred" | "shared";
const SOURCES: { id: Source; label: string }[] = [
  { id: "drive", label: "Files" },
  { id: "starred", label: "Starred" },
  { id: "shared", label: "Shared" },
];

export function DriveScreen({ refreshKey, onOpenFile }: { refreshKey: number; onOpenFile: (f: FileItem) => void }) {
  const [source, setSource] = useState<Source>("drive");
  const [path, setPath] = useState("");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    // "Starred" mirrors the desktop: filter the drive root rather than a global
    // query (there's no list-starred endpoint). "Shared" uses its own listing.
    const load = source === "shared" ? listShared() : listFiles(source === "starred" ? "" : path);
    load
      .then((items) => setFiles(source === "starred" ? items.filter((f) => f.starred) : items))
      .catch((e: Error) => {
        setFiles([]);
        setError(e.message);
      });
  }, [source, path, refreshKey]);

  const filtered = useMemo(() => {
    if (source !== "drive") return files;
    const chip = CHIPS.find((c) => c.id === filter);
    if (!chip || chip.id === "all") return files;
    return files.filter((f) => (chip.folders ? f.kind === "folder" : chip.kinds?.includes(f.kind)));
  }, [files, filter, source]);

  const segments = path.split("/").filter(Boolean);
  const title = source === "starred" ? "Starred" : source === "shared" ? "Shared with me" : segments[segments.length - 1] ?? "My Drive";

  function open(f: FileItem) {
    if (source === "drive" && f.kind === "folder" && f.path != null) setPath(f.path);
    else onOpenFile(f);
  }

  return (
    <div>
      {/* Source switch */}
      <div className="flex gap-2 px-[18px] pb-3 pt-2">
        {SOURCES.map((s) => {
          const active = source === s.id;
          return (
            <button
              key={s.id}
              onClick={() => setSource(s.id)}
              className={cn(
                "h-8 flex-1 rounded-full text-[13px] font-medium transition-colors",
                active ? "bg-primary text-primary-foreground" : "border bg-card text-foreground/80",
              )}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      <div className="px-[18px] pb-3.5">
        {source === "drive" && (
          <div className="mb-2 flex items-center gap-1 whitespace-nowrap text-[12.5px] font-medium text-muted-foreground">
            <Icon name="cloud" size={12} className="text-primary" />
            <button onClick={() => setPath("")} className="shrink-0">{STORAGE.label}</button>
            <Icon name="chevron-right" size={11} />
            <span className="shrink-0 font-semibold text-foreground">{title}</span>
          </div>
        )}
        <h1 className="text-[30px] font-semibold tracking-tight">{title}</h1>
        <div className="mt-1 font-mono text-[13px] text-muted-foreground">{filtered.length} items</div>
      </div>

      <div className="px-[18px] pb-3">
        <SearchPill label={`Search ${source === "drive" ? "My Drive" : title}`} compact />
      </div>

      {source === "drive" && (
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
      )}

      {error ? (
        <div className="mx-[18px] rounded-xl border border-dashed p-6 text-center text-[13px] text-muted-foreground">
          Couldn't reach the storage API.
        </div>
      ) : (
        <div className="border-y bg-card">
          {filtered.map((f) => (
            <MFileRow key={f.id} file={f} onClick={() => open(f)} />
          ))}
          {filtered.length === 0 && (
            <div className="px-[18px] py-8 text-center text-[13px] text-muted-foreground">
              {source === "starred" ? "Nothing starred yet." : source === "shared" ? "Nothing shared with you." : "Nothing here."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Spaces ────────────────────────────────────────────────────────────────

const ROLE_LABEL: Record<string, string> = { owner: "Owner", editor: "Can edit", viewer: "Can view" };

export function SpacesScreen({ spaces, refreshKey, onOpenFile }: { spaces: SpaceView[]; refreshKey: number; onOpenFile: (f: FileItem) => void }) {
  // A space the user has drilled into (its files), or null at the list level.
  const [open, setOpen] = useState<SpaceView | null>(null);
  const groups = spaces.filter((s) => s.kind === "group");

  if (open) return <SpaceFilesScreen space={open} refreshKey={refreshKey} onBack={() => setOpen(null)} onOpenFile={onOpenFile} />;

  return (
    <div>
      <div className="px-[18px] pb-4 pt-2">
        <h1 className="text-[30px] font-semibold tracking-tight">Spaces</h1>
        <div className="mt-1 text-[13px] text-muted-foreground">
          {groups.length === 0
            ? "Shared spaces for your family, projects or groups."
            : `${groups.length} ${groups.length === 1 ? "space" : "spaces"} shared with you`}
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="mx-[18px] flex flex-col items-center gap-3 rounded-2xl border border-dashed p-8 text-center">
          <span className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
            <Icon name="users" size={22} />
          </span>
          <div className="text-[14px] font-medium">No spaces yet</div>
          <div className="max-w-[240px] text-[12.5px] text-muted-foreground">
            Create a space to share files with the people you choose — like a “Family” space.
          </div>
          <button className="mt-1 h-9 rounded-full bg-primary px-4 text-[13px] font-semibold text-primary-foreground">
            Create a space
          </button>
        </div>
      ) : (
        <div className="border-y bg-card">
          {groups.map((s) => (
            <button
              key={s.id}
              onClick={() => setOpen(s)}
              className="flex w-full items-center gap-3 border-b px-[18px] py-3 text-left last:border-0"
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                <Icon name="users" size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14.5px] font-medium">{s.name}</div>
                <div className="mt-0.5 text-[11.5px] text-muted-foreground">{ROLE_LABEL[s.role] ?? s.role}</div>
              </div>
              <Icon name="chevron-right" size={14} className="shrink-0 text-muted-foreground" />
            </button>
          ))}
          <button className="flex w-full items-center gap-3 px-[18px] py-3 text-left text-muted-foreground">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted">
              <Icon name="plus" size={18} />
            </span>
            <span className="text-[14px] font-medium">New space…</span>
          </button>
        </div>
      )}
    </div>
  );
}

function SpaceFilesScreen({
  space,
  refreshKey,
  onBack,
  onOpenFile,
}: {
  space: SpaceView;
  refreshKey: number;
  onBack: () => void;
  onOpenFile: (f: FileItem) => void;
}) {
  const [path, setPath] = useState("");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    listFiles(path, space.id)
      .then(setFiles)
      .catch((e: Error) => {
        setFiles([]);
        setError(e.message);
      });
  }, [space.id, path, refreshKey]);

  const segments = path.split("/").filter(Boolean);

  function open(f: FileItem) {
    if (f.kind === "folder" && f.path != null) setPath(f.path);
    else onOpenFile(f);
  }

  // Back steps out of a subfolder first, then leaves the space.
  const goBack = () => (segments.length ? setPath(segments.slice(0, -1).join("/")) : onBack());

  return (
    <div>
      <div className="px-[18px] pb-3.5 pt-2">
        <button onClick={goBack} className="mb-2 flex items-center gap-1 text-[13px] font-medium text-primary">
          <Icon name="chevron-left" size={15} /> {segments.length ? space.name : "Spaces"}
        </button>
        <h1 className="text-[30px] font-semibold tracking-tight">{segments[segments.length - 1] ?? space.name}</h1>
        <div className="mt-1 font-mono text-[13px] text-muted-foreground">{files.length} items</div>
      </div>
      {error ? (
        <div className="mx-[18px] rounded-xl border border-dashed p-6 text-center text-[13px] text-muted-foreground">
          Couldn't load this space.
        </div>
      ) : (
        <div className="border-y bg-card">
          {files.map((f) => (
            <MFileRow key={f.id} file={f} onClick={() => open(f)} />
          ))}
          {files.length === 0 && <div className="px-[18px] py-8 text-center text-[13px] text-muted-foreground">This space is empty.</div>}
        </div>
      )}
    </div>
  );
}

// ── Apps ────────────────────────────────────────────────────────────────

export function AppsScreen({ installed, onInstall }: { installed: string[]; onInstall: (id: string) => void }) {
  // Resolve installed ids and the rest of the store from the shared catalog, so
  // this stays in sync with what the user actually has (no hardcoded list).
  const installedApps = PLUGIN_CATALOG.filter((c) => installed.includes(c.id));
  const storeApps = PLUGIN_CATALOG.filter((c) => !installed.includes(c.id));

  return (
    <div>
      <div className="px-[18px] pb-4 pt-2">
        <h1 className="text-[30px] font-semibold tracking-tight">Apps</h1>
        <div className="mt-1 text-[13px] text-muted-foreground">Add only what your family will actually use.</div>
      </div>

      {installedApps.length > 0 && (
        <>
          <div className="px-[18px] pb-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground">Installed</div>
          <div className="mb-6 flex flex-col gap-2.5 px-[18px]">
            {installedApps.map((a) => (
              <div key={a.id} className="rounded-2xl border bg-card p-3.5">
                <AppCardHead color={a.color} icon={a.icon} label={a.label} tagline={a.tagline} />
              </div>
            ))}
          </div>
        </>
      )}

      {storeApps.length > 0 && (
        <>
          <div className="px-[18px] pb-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground">From the store</div>
          <div className="flex flex-col gap-2.5 px-[18px]">
            {storeApps.map((s) => (
              <div key={s.id} className="flex items-center gap-3 rounded-2xl border bg-card p-3">
                <span className="grid size-[38px] shrink-0 place-items-center rounded-[11px]" style={{ background: `hsl(${s.color} / 0.14)`, color: `hsl(${s.color})` }}>
                  <Icon name={s.icon} size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold">{s.label}</div>
                  <div className="text-[12px] text-muted-foreground">{s.tagline}</div>
                </div>
                <button onClick={() => onInstall(s.id)} className="h-7 rounded-full bg-primary px-3 text-[12.5px] font-semibold text-primary-foreground active:scale-95">Install</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function AppCardHead({ color, icon, label, tagline }: { color: string; icon: string; label: string; tagline: string }) {
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
