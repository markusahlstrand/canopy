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
import { STORAGE, CURRENT_USER } from "@/lib/mock-data";
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
];

interface SidebarProps {
  active: string;
  onNavigate: (id: string) => void;
  installedPlugins: PluginManifest[];
  onOpenStore: () => void;
  collapsed: boolean;
  onToggle: () => void;
  spaces: SpaceView[];
  currentSpace: string;
  onOpenSpace: (id: string) => void;
  onCreateSpace: () => void;
  onNewFolder: () => void;
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
  onOpenStore,
  collapsed,
  onToggle,
  spaces,
  currentSpace,
  onOpenSpace,
  onCreateSpace,
  onNewFolder,
  onUpload,
  onConnectDevice,
  auth,
  onSignIn,
  onSignOut,
}: SidebarProps) {
  const groupSpaces = spaces.filter((s) => s.kind === "group");
  const realUser = auth.user;
  const displayUser = realUser
    ? {
        name: realUser.name ?? realUser.email ?? "Account",
        email: realUser.email ?? "",
        initials: initialsOf(realUser.name ?? realUser.email ?? "U"),
      }
    : auth.authConfigured
      ? null
      : CURRENT_USER;
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

      {/* New button */}
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
            <DropdownMenuItem onClick={onUpload}>
              <Icon name="upload" size={15} /> Upload files
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

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
            {groupSpaces.map((s) => (
              <NavRow
                key={s.id}
                icon="users"
                label={s.name}
                active={active === "drive" && currentSpace === s.id}
                collapsed={false}
                onClick={() => onOpenSpace(s.id)}
              />
            ))}
            {groupSpaces.length === 0 && (
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

      {/* Plugins */}
      <div className={cn("mt-5 flex min-h-0 flex-1 flex-col px-3", collapsed && "px-2")}>
        {!collapsed && (
          <div className="mb-1 flex items-center justify-between px-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Plugins</span>
            <button onClick={onOpenStore} className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-accent">
              <Icon name="plus" size={14} />
            </button>
          </div>
        )}
        <div className="flex flex-col gap-0.5 overflow-y-auto">
          {installedPlugins.map((p) => (
            <NavRow
              key={p.id}
              icon={p.icon ?? "plugin"}
              label={p.name}
              dot={p.id === "tasks"}
              count={p.id === "calendar" ? 3 : p.id === "tasks" ? 4 : undefined}
              active={active === `plugin:${p.id}`}
              collapsed={collapsed}
              onClick={() => onNavigate(`plugin:${p.id}`)}
            />
          ))}
          {!collapsed && (
            <button
              onClick={onOpenStore}
              className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13.5px] text-muted-foreground hover:bg-accent/60"
            >
              <Icon name="plugin" size={17} />
              Browse plugins
            </button>
          )}
        </div>
      </div>

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
