import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginManifest } from "@canopy/core";
import { Icon } from "@/lib/icons";
import { CanopyMark } from "@/components/canopy-mark";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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
import { connectorStatus, testConnector } from "@/lib/api";
import type { Me, SpaceView } from "@/lib/api";

function initialsOf(s: string): string {
  const parts = s.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "U";
}

type ConnStatus = "connecting" | "connected" | "error";

const STATUS_DOT: Record<ConnStatus, { color: string; label: string; pulse?: boolean }> = {
  connecting: { color: "bg-amber-500", label: "Connecting…", pulse: true },
  connected: { color: "bg-green-500", label: "Connected" },
  error: { color: "bg-red-500", label: "Not available" },
};

function StatusDot({ status }: { status: ConnStatus }) {
  const meta = STATUS_DOT[status];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("size-2 shrink-0 rounded-full", meta.color, meta.pulse && "animate-pulse")} />
      </TooltipTrigger>
      <TooltipContent side="right">{meta.label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Live reachability of each connected space's backend (Synology, GitHub, …):
 * probes `testConnector` so the sidebar can show green (reachable), amber
 * (checking) or red (can't connect). Re-probes on window focus, keeping the last
 * known color until the new result lands so a connected space doesn't flicker
 * amber on every refocus.
 */
function useConnectorStatuses(connectedSpaces: SpaceView[]): Record<string, ConnStatus> {
  const [statuses, setStatuses] = useState<Record<string, ConnStatus>>({});
  // Stable dependency: the effect only re-subscribes when the set of spaces changes,
  // not on every render (the `filter` in the parent makes a fresh array each time).
  const ids = connectedSpaces.map((s) => s.id).join(",");
  useEffect(() => {
    const spaceIds = ids ? ids.split(",") : [];
    if (spaceIds.length === 0) return; // nothing connected → nothing to probe or render
    let alive = true;
    const probe = () => {
      for (const spaceId of spaceIds) {
        const pluginId = spaceId.slice("connector:".length);
        if (!pluginId) continue;
        // Show amber only on the first probe; later re-checks keep the prior color.
        setStatuses((prev) => (prev[spaceId] ? prev : { ...prev, [spaceId]: "connecting" }));
        testConnector(pluginId)
          .then((res) => alive && setStatuses((prev) => ({ ...prev, [spaceId]: res.ok ? "connected" : "error" })))
          .catch(() => alive && setStatuses((prev) => ({ ...prev, [spaceId]: "error" })));
      }
    };
    probe();
    window.addEventListener("focus", probe);
    return () => {
      alive = false;
      window.removeEventListener("focus", probe);
    };
  }, [ids]);
  return statuses;
}

type IndexState = { indexing: boolean; pending: number };

/**
 * Indexing progress of each connected space, polled from the cheap DB-only status
 * endpoint so the sidebar can show an "Indexing…" spinner while a crawl runs or text
 * extraction is still draining. Polls fast (3s) while anything is indexing and slow
 * (15s) when idle, with a one-off refresh on window focus and via the returned
 * `refresh()` — which the "Sync / Re-index" action calls so the spinner shows promptly.
 */
function useIndexingStatuses(connectedSpaces: SpaceView[]): [Record<string, IndexState>, () => void] {
  const [statuses, setStatuses] = useState<Record<string, IndexState>>({});
  const refreshRef = useRef<() => void>(() => {});
  const ids = connectedSpaces.map((s) => s.id).join(",");
  useEffect(() => {
    const spaceIds = ids ? ids.split(",") : [];
    if (spaceIds.length === 0) {
      refreshRef.current = () => {};
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // `schedule` keeps exactly one self-scheduling chain alive; focus/refresh do a
    // one-off poll (schedule=false) so they never spawn a second competing timer.
    const tick = async (schedule: boolean) => {
      const results = await Promise.all(
        spaceIds.map(async (spaceId) => {
          const pluginId = spaceId.slice("connector:".length);
          const st = await connectorStatus(pluginId);
          return [spaceId, { indexing: st.indexing, pending: st.pending }] as const;
        }),
      );
      if (!alive) return;
      setStatuses(Object.fromEntries(results));
      if (schedule) {
        const active = results.some(([, st]) => st.indexing);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void tick(true), active ? 3000 : 15000);
      }
    };
    refreshRef.current = () => void tick(false);
    void tick(true);
    const onFocus = () => void tick(false);
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [ids]);
  const refresh = useCallback(() => refreshRef.current(), []);
  return [statuses, refresh];
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
  /** Open a space's offline-cache settings (how much to keep on this device). Any role. */
  onCacheSettings: (space: string, name: string) => void;
  /** Re-index a connected space (the "Sync now" action). `id` is the `connector:<plugin>` token. */
  onSyncSpace: (id: string) => void;
  /** Open a connected space's settings (indexing log + version retention). `id` is the `connector:<plugin>` token. */
  onConnectorSettings: (id: string, name: string) => void;
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
  onCacheSettings,
  onSyncSpace,
  onConnectorSettings,
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
  const connectorStatuses = useConnectorStatuses(connectedSpaces);
  const [indexingStatuses, refreshIndexing] = useIndexingStatuses(connectedSpaces);
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
    <TooltipProvider>
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
        {NAV.map((n) => {
          const row = (
            <NavRow
              key={n.id}
              icon={n.icon}
              label={n.label}
              // "My Drive" is the personal space; highlight only when no group space is open.
              active={n.id === "drive" ? active === "drive" && !currentSpace : active === n.id}
              collapsed={collapsed}
              onClick={() => onNavigate(n.id)}
            />
          );
          // The personal drive ("") has no settings dialog, so its offline-cache control
          // hangs off a right-click here — mirroring the group/connected spaces below.
          if (n.id !== "drive" || collapsed) return row;
          return (
            <ContextMenu key={n.id}>
              <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
              <ContextMenuContent className="w-48">
                <ContextMenuItem onSelect={() => onCacheSettings("", "My Drive")}>
                  <Icon name="cloud" size={15} /> Offline files…
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
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
                      <span
                        className={cn("shrink-0", isActive && "text-primary")}
                        style={!isActive && s.color ? { color: `hsl(${s.color})` } : undefined}
                      >
                        <Icon name={s.icon || "users"} size={17} />
                      </span>
                      <span className="flex-1 truncate text-left">{s.name}</span>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-48">
                    <ContextMenuItem onSelect={() => onOpenSpace(s.id)}>
                      <Icon name={s.icon || "users"} size={15} /> Open
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => onCacheSettings(s.id, s.name)}>
                      <Icon name="cloud" size={15} /> Offline files…
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
              const status = connectorStatuses[s.id];
              const idx = indexingStatuses[s.id];
              return (
                <ContextMenu key={s.id}>
                  <ContextMenuTrigger asChild>
                    <button
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
                      {/* While indexing, the spinner takes the dot's slot (work in progress
                          trumps reachability); otherwise the reachability dot. */}
                      {idx?.indexing ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="shrink-0 text-primary">
                              <Icon name="refresh" size={13} className="animate-spin" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="right">
                            {idx.pending > 0
                              ? `Indexing… ${idx.pending} file${idx.pending === 1 ? "" : "s"} left`
                              : "Indexing…"}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        status && <StatusDot status={status} />
                      )}
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-48">
                    <ContextMenuItem onSelect={() => onOpenSpace(s.id)}>
                      <Icon name="github" size={15} /> Open
                    </ContextMenuItem>
                    <ContextMenuItem
                      onSelect={() => {
                        onSyncSpace(s.id);
                        // The crawl is kicked in the background; give it a beat to record
                        // a run row, then refresh so the "Indexing…" spinner shows promptly.
                        setTimeout(refreshIndexing, 1500);
                      }}
                    >
                      <Icon name="refresh" size={15} /> Sync / Re-index
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => onCacheSettings(s.id, s.name)}>
                      <Icon name="cloud" size={15} /> Offline files…
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => onConnectorSettings(s.id, s.name)}>
                      <Icon name="settings" size={15} /> Settings
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
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
    </TooltipProvider>
  );
}
