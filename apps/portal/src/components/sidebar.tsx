import type { PluginManifest } from "@canopy/core";
import { Icon } from "@/lib/icons";
import { CanopyMark } from "@/components/canopy-mark";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { STORAGE } from "@/lib/mock-data";
import { creatorsFor, type InstalledCreator } from "@/plugins/viewers";
import type { Me, SpaceView } from "@/lib/api";

function initialsOf(s: string): string {
  const parts = s.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "U";
}

const NAV = [
  { id: "home", icon: "home", label: "Home" },
  { id: "drive", icon: "my-drive", label: "My Drive" },
  { id: "starred", icon: "starred", label: "Starred" },
  { id: "trash", icon: "trash", label: "Trash" },
  { id: "settings", icon: "settings", label: "Settings" },
];

interface SidebarProps {
  active: string;
  onNavigate: (id: string) => void;
  installedPlugins: PluginManifest[];
  collapsed: boolean;
  onToggle: () => void;
  spaces: SpaceView[];
  currentSpace: string;
  /** The current space is read-only (a connected repo): hide create/upload actions. */
  readonly: boolean;
  onOpenSpace: (id: string) => void;
  onCreateSpace: () => void;
  onRenameSpace: (id: string) => void;
  /** Open the space's settings (members/plugins/danger zone). Owner only. */
  onManageSpace: (id: string) => void;
  onToggleMount: (id: string, mounted: boolean) => void;
  onNewFolder: () => void;
  onNewFile: (creator: InstalledCreator) => void;
  onUpload: () => void;
  onConnectDevice: () => void;
  auth: Me;
  onSignIn: () => void;
  onSignOut: () => void;
}

function NavRow({
  icon,
  label,
  count,
  dot,
  active,
  collapsed,
  onClick,
}: {
  icon: string;
  label: string;
  count?: number;
  dot?: boolean;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  const row = (
    <button
      onClick={onClick}
      className={cn(
        "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-[13.5px] transition-colors",
        collapsed && "justify-center px-0",
        active ? "bg-accent font-medium text-foreground" : "text-foreground/80 hover:bg-accent/60",
      )}
    >
      <span className={cn("shrink-0", active && "text-primary")}>
        <Icon name={icon} size={17} />
      </span>
      {!collapsed && (
        <>
          <span className="flex-1 truncate text-left">{label}</span>
          {dot && <span className="size-1.5 rounded-full bg-primary" />}
          {count != null && <span className="font-mono text-[11.5px] text-muted-foreground">{count}</span>}
        </>
      )}
    </button>
  );
  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{row}</TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }
  return row;
}

export function Sidebar({
  active,
  onNavigate,
  installedPlugins,
  collapsed,
  onToggle,
  spaces,
  currentSpace,
  readonly,
  onOpenSpace,
  onCreateSpace,
  onRenameSpace,
  onManageSpace,
  onToggleMount,
  onNewFolder,
  onNewFile,
  onUpload,
  onConnectDevice,
  auth,
  onSignIn,
  onSignOut,
}: SidebarProps) {
  const creators = creatorsFor(installedPlugins.map((p) => p.id));
  const groupSpaces = spaces.filter((s) => s.kind === "group");
  const connectedSpaces = spaces.filter((s) => s.kind === "connected");
  // Installed "app" plugins that declare a sidebar launcher (contributes.detailView.nav),
  // grouped under the section heading each one names (e.g. "Games", "Tools").
  const navSections = (() => {
    const groups = new Map<string, PluginManifest[]>();
    for (const p of installedPlugins) {
      const section = p.contributes?.detailView?.nav?.section?.trim();
      if (!section) continue;
      groups.set(section, [...(groups.get(section) ?? []), p]);
    }
    return [...groups.entries()];
  })();
  const realUser = auth.user;
  // No real user → render the "Sign in" row, never a fabricated demo persona.
  const displayUser = realUser
    ? {
        name: realUser.name ?? realUser.email ?? "Account",
        email: realUser.email ?? "",
        initials: initialsOf(realUser.name ?? realUser.email ?? "U"),
      }
    : null;
  return (
    <aside className="flex h-full flex-col border-r bg-card">
      {/* Logo row */}
      <div className={cn("flex h-14 items-center gap-2 px-3", collapsed && "justify-center px-0")}>
        <div className="grid size-[26px] shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
          <CanopyMark size={16} />
        </div>
        {!collapsed && (
          <>
            <span className="flex-1 text-[15.5px] font-semibold tracking-tight">Canopy</span>
            <button onClick={onToggle} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent">
              <Icon name="panel-left" size={16} />
            </button>
          </>
        )}
      </div>

      {/* New button — hidden in a read-only (connected) space */}
      {!readonly && (
      <div className={cn("px-3 pb-2", collapsed && "px-2")}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button className="w-full justify-center gap-1.5" size={collapsed ? "icon" : "default"}>
              <Icon name="plus" size={16} strokeWidth={2.25} />
              {!collapsed && (
                <>
                  <span className="flex-1 text-left">New</span>
                  <Icon name="chevron-down" size={14} />
                </>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuItem onClick={onNewFolder}>
              <Icon name="folder" size={15} /> New folder
            </DropdownMenuItem>
            {creators.map((creator) => (
              <DropdownMenuItem key={creator.plugin + ":" + creator.id} onClick={() => onNewFile(creator)}>
                <Icon name={creator.icon ?? "file"} size={15} /> {creator.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onClick={onUpload}>
              <Icon name="upload" size={15} /> Upload files
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      )}

      {/* Main nav */}
      <nav className={cn("flex flex-col gap-0.5 px-3", collapsed && "px-2")}>
        {NAV.map((n) => (
          <NavRow
            key={n.id}
            icon={n.icon}
            label={n.label}
            // "My Drive" is the personal space; highlight only when no group space is open.
            active={n.id === "drive" ? active === "drive" && !currentSpace : active === n.id}
            collapsed={collapsed}
            onClick={() => onNavigate(n.id)}
          />
        ))}
      </nav>

      {/* Spaces (families / groups) — also surfaced inline in My Drive when mounted */}
      {!collapsed && (
        <div className="mt-4 px-3">
          <div className="mb-1 flex items-center justify-between px-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Spaces</span>
            <button
              onClick={onCreateSpace}
              title="New space"
              className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-accent"
            >
              <Icon name="plus" size={14} />
            </button>
          </div>
          <div className="flex flex-col gap-0.5">
            {groupSpaces.map((s) => {
              const isActive = active === "drive" && currentSpace === s.id;
              return (
                <ContextMenu key={s.id}>
                  <ContextMenuTrigger asChild>
                    <button
                      onClick={() => onOpenSpace(s.id)}
                      className={cn(
                        "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-[13.5px] transition-colors",
                        isActive ? "bg-accent font-medium text-foreground" : "text-foreground/80 hover:bg-accent/60",
                      )}
                    >
                      <span className={cn("shrink-0", isActive && "text-primary")}>
                        <Icon name="users" size={17} />
                      </span>
                      <span className="flex-1 truncate text-left">{s.name}</span>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-48">
                    <ContextMenuItem onSelect={() => onOpenSpace(s.id)}>
                      <Icon name="users" size={15} /> Open
                    </ContextMenuItem>
                    {s.role === "owner" && (
                      <>
                        <ContextMenuItem onSelect={() => onRenameSpace(s.id)}>
                          <Icon name="edit" size={15} /> Rename
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => onManageSpace(s.id)}>
                          <Icon name="settings" size={15} /> Settings
                        </ContextMenuItem>
                      </>
                    )}
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => onToggleMount(s.id, !s.mounted)}>
                      <Icon name={s.mounted ? "eye-off" : "eye"} size={15} />
                      {s.mounted ? "Hide from My Drive" : "Show in My Drive"}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
            {/* Connected repos (read-only, derived from a source plugin's config). */}
            {connectedSpaces.map((s) => {
              const isActive = active === "drive" && currentSpace === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => onOpenSpace(s.id)}
                  title={`${s.name} (read-only)`}
                  className={cn(
                    "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-[13.5px] transition-colors",
                    isActive ? "bg-accent font-medium text-foreground" : "text-foreground/80 hover:bg-accent/60",
                  )}
                >
                  <span className={cn("shrink-0", isActive && "text-primary")}>
                    <Icon name="github" size={17} />
                  </span>
                  <span className="flex-1 truncate text-left">{s.name}</span>
                </button>
              );
            })}
            {groupSpaces.length === 0 && connectedSpaces.length === 0 && (
              <button
                onClick={onCreateSpace}
                className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13.5px] text-muted-foreground hover:bg-accent/60"
              >
                <Icon name="users" size={17} /> New space…
              </button>
            )}
          </div>
        </div>
      )}

      {/* App plugins (Plugin Studio "apps" / any plugin contributing a navigable
          detailView) launch straight from the sidebar, grouped by their declared
          section. File-viewer plugins have no entry here — they open via files. */}
      {navSections.map(([section, plugins]) => (
        <div key={section} className={cn("mt-4 px-3", collapsed && "px-2")}>
          {!collapsed && (
            <div className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {section}
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            {plugins.map((p) => (
              <NavRow
                key={p.id}
                icon={p.icon ?? "plugin"}
                label={p.name}
                active={active === `plugin:${p.id}`}
                collapsed={collapsed}
                onClick={() => onNavigate(`plugin:${p.id}`)}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Spacer anchors the storage + user cards to the bottom. */}
      <div className="min-h-4 flex-1" />

      {/* Storage card */}
      {!collapsed && (
        <div className="m-2.5 rounded-lg bg-muted p-3">
          <div className="mb-2 flex items-center gap-2 text-[13px]">
            <Icon name="cloud" size={15} className="text-muted-foreground" />
            <span className="truncate font-medium">{STORAGE.label}</span>
          </div>
          <Progress value={STORAGE.percent} className="h-1.5" />
          <div className="mt-1.5 flex justify-between font-mono text-[11px] text-muted-foreground">
            <span>
              {STORAGE.used} of {STORAGE.total}
            </span>
            <span>{STORAGE.percent}%</span>
          </div>
        </div>
      )}

      {/* User row */}
      {displayUser ? (
        <div className={cn("flex items-center gap-2.5 border-t px-3 py-2.5", collapsed && "justify-center px-0")}>
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
            {displayUser.initials}
          </span>
          {!collapsed && (
            <>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{displayUser.name}</div>
                <div className="truncate text-[11.5px] text-muted-foreground">{displayUser.email}</div>
              </div>
              {realUser && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent">
                      <Icon name="more" size={16} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuItem onClick={onConnectDevice}>
                      <Icon name="cloud" size={15} /> Connect a device…
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={onSignOut}>
                      <Icon name="log-out" size={15} /> Sign out
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </>
          )}
        </div>
      ) : collapsed ? (
        <button
          onClick={onSignIn}
          title="Sign in"
          className="grid h-12 place-items-center border-t text-muted-foreground hover:bg-accent"
        >
          <Icon name="log-out" size={16} className="rotate-180" />
        </button>
      ) : (
        <div className="border-t p-2.5">
          <Button variant="outline" className="w-full gap-1.5" onClick={onSignIn}>
            <Icon name="log-out" size={15} className="rotate-180" /> Sign in
          </Button>
        </div>
      )}

      {collapsed && (
        <button
          onClick={onToggle}
          className="mb-2 grid h-8 place-items-center text-muted-foreground hover:bg-accent"
          title="Expand sidebar"
        >
          <Icon name="panel-left" size={16} />
        </button>
      )}
    </aside>
  );
}
