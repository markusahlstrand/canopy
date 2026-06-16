import { Icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Me } from "@/lib/api";
import { BranchPicker } from "@/components/branch-picker";

function initialsOf(s: string): string {
  const parts = s.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "U";
}

// Keep the first crumb + last two; anything deeper collapses behind a `…` menu so
// a deep path can't squeeze the search box or wrap the topbar onto a second row.
const HEAD = 1;
const TAIL = 2;
type Crumb = { label: string; index: number };
type CrumbItem =
  | { kind: "crumb"; label: string; index: number }
  | { kind: "ellipsis"; hidden: Crumb[] };

function crumbModel(breadcrumb: string[]): CrumbItem[] {
  // Only worth collapsing once the `…` would hide more than one segment.
  if (breadcrumb.length <= HEAD + TAIL + 1) {
    return breadcrumb.map((label, index) => ({ kind: "crumb", label, index }));
  }
  const hidden: Crumb[] = breadcrumb
    .slice(HEAD, breadcrumb.length - TAIL)
    .map((label, i) => ({ label, index: HEAD + i }));
  return [
    ...breadcrumb.slice(0, HEAD).map((label, index): CrumbItem => ({ kind: "crumb", label, index })),
    { kind: "ellipsis", hidden },
    ...breadcrumb
      .slice(breadcrumb.length - TAIL)
      .map((label, i): CrumbItem => ({ kind: "crumb", label, index: breadcrumb.length - TAIL + i })),
  ];
}

interface TopbarProps {
  breadcrumb: string[];
  onCrumbClick?: (index: number) => void;
  onOpenCmd: () => void;
  onOpenStore: () => void;
  /** Open the Settings page (avatar menu → Settings, and the ⌘, shortcut). */
  onOpenSettings: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onUpload: () => void;
  /** Hide the Upload button in a read-only (connected) space. */
  readonly?: boolean;
  /** When the current view is a connected space, its connector plugin id — enables the
   *  branch picker (it self-hides for connectors without a branch concept, e.g. a NAS). */
  connectorPluginId?: string | null;
  /** The active branch of the connected space, mirrored in the host's URL ("" until probed). */
  branch?: string;
  /** The user picked a branch — host persists + re-indexes + updates the URL. */
  onBranchSwitch?: (name: string) => Promise<void>;
  /** The picker probed the connector's current branch — host reconciles it with the URL. */
  onBranchDiscover?: (current: string) => void;
  railAvailable: boolean;
  railOpen: boolean;
  onToggleRail: () => void;
  auth: Me;
  onSignIn: () => void;
  onSignOut: () => void;
  /** Backend unreachable — the app is view-only, so disable uploads. */
  offline?: boolean;
  /** Force a re-fetch of the current view (re-syncs the offline mirror + reloads). */
  onRefresh?: () => void;
  /** True while a background sync is in flight — spins the refresh icon. */
  syncing?: boolean;
}

export function Topbar({
  breadcrumb,
  onCrumbClick,
  onOpenCmd,
  onOpenStore,
  onOpenSettings,
  theme,
  onToggleTheme,
  onUpload,
  readonly,
  connectorPluginId,
  branch,
  onBranchSwitch,
  onBranchDiscover,
  railAvailable,
  railOpen,
  onToggleRail,
  auth,
  onSignIn,
  onSignOut,
  offline,
  onRefresh,
  syncing,
}: TopbarProps) {
  const realUser = auth.user;
  // Logged out whenever there's no real authenticated user. Never fall back to a
  // fabricated demo persona — that used to render "MC" (Maya Chen) in the avatar
  // and hide the login button whenever the backend reported auth as unconfigured.
  const loggedOut = !realUser;
  const display = realUser
    ? {
        name: realUser.name ?? realUser.email ?? "Account",
        email: realUser.email ?? "",
        initials: initialsOf(realUser.name ?? realUser.email ?? "U"),
      }
    : { name: "Not signed in", email: "", initials: "?" };
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
      {/* Breadcrumb */}
      <div className="flex min-w-0 items-center gap-1.5 text-[14px]">
        {crumbModel(breadcrumb).map((item) => {
          if (item.kind === "ellipsis") {
            return (
              <span key="ellipsis" className="flex items-center gap-1.5">
                {onCrumbClick ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        aria-label="Show hidden folders"
                        className="rounded px-1 leading-none text-muted-foreground hover:text-foreground"
                      >
                        …
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      {item.hidden.map((h) => (
                        <DropdownMenuItem key={h.index} onClick={() => onCrumbClick(h.index)}>
                          {h.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <span className="px-1 text-muted-foreground" title={item.hidden.map((h) => h.label).join(" / ")}>
                    …
                  </span>
                )}
                <span className="text-muted-foreground/60">›</span>
              </span>
            );
          }
          const last = item.index === breadcrumb.length - 1;
          return (
            <span key={item.index} className="flex items-center gap-1.5">
              {onCrumbClick && !last ? (
                <button
                  onClick={() => onCrumbClick(item.index)}
                  className="max-w-[200px] truncate text-muted-foreground hover:text-foreground"
                >
                  {item.label}
                </button>
              ) : (
                <span className={cn("max-w-[200px] truncate", last ? "font-semibold" : "text-muted-foreground")}>
                  {item.label}
                </span>
              )}
              {!last && <span className="text-muted-foreground/60">›</span>}
            </span>
          );
        })}
      </div>

      {/* Branch picker — only for a connected space whose connector has branches (GitHub) */}
      {connectorPluginId && (
        <BranchPicker
          key={connectorPluginId}
          pluginId={connectorPluginId}
          branch={branch ?? ""}
          onSwitch={onBranchSwitch ?? (async () => {})}
          onDiscover={onBranchDiscover ?? (() => {})}
        />
      )}

      <div className="flex-1" />

      {/* Search trigger */}
      <button
        onClick={onOpenCmd}
        className="flex h-9 w-[280px] items-center gap-2 rounded-md border bg-background px-3 text-[13.5px] text-muted-foreground transition-colors hover:bg-accent/40"
      >
        <Icon name="search" size={15} />
        <span className="flex-1 text-left">Search or jump to…</span>
        <kbd className="rounded bg-muted px-1.5 font-mono text-[10.5px]">⌘</kbd>
        <kbd className="rounded bg-muted px-1.5 font-mono text-[10.5px]">K</kbd>
      </button>

      {/* Bell */}
      <button className="relative grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-accent">
        <Icon name="bell" size={18} />
        <span className="absolute right-2 top-2 size-[7px] rounded-full bg-primary ring-2 ring-background" />
      </button>

      {/* Refresh — force a re-sync + reload of the current view */}
      {onRefresh && (
        <button
          onClick={onRefresh}
          disabled={offline}
          title={offline ? "Unavailable while offline" : "Refresh"}
          aria-label="Refresh"
          className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-accent disabled:opacity-50"
        >
          <Icon name="refresh" size={18} className={cn(syncing && "animate-spin")} />
        </button>
      )}

      {/* Theme toggle */}
      <button onClick={onToggleTheme} className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-accent">
        <Icon name={theme === "dark" ? "sun" : "moon"} size={18} />
      </button>

      {/* Right panel toggle */}
      {railAvailable && (
        <button
          onClick={onToggleRail}
          title={railOpen ? "Hide panel" : "Show panel"}
          aria-pressed={railOpen}
          className={cn(
            "grid size-9 place-items-center rounded-md hover:bg-accent",
            railOpen ? "bg-accent text-foreground" : "text-muted-foreground",
          )}
        >
          <Icon name="panel-right" size={18} />
        </button>
      )}

      {/* Upload — hidden in a read-only (connected) space */}
      {!readonly && (
        <Button
          onClick={onUpload}
          disabled={offline}
          title={offline ? "Unavailable while offline" : undefined}
          className="gap-1.5"
        >
          <Icon name="upload" size={16} />
          Upload
        </Button>
      )}

      {/* Account: square login button when logged out, avatar menu otherwise */}
      {loggedOut ? (
        <Button
          onClick={onSignIn}
          disabled={auth.offline}
          title={auth.offline ? "You're offline" : undefined}
          className="gap-1.5"
        >
          <Icon name="log-out" size={16} className="rotate-180" /> Log in
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-[12px] font-semibold text-primary-foreground">
              {display.initials}
            </button>
          </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>
            <div className="font-medium">{display.name}</div>
            {display.email && (
              <div className="text-[12px] font-normal text-muted-foreground">{display.email}</div>
            )}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onOpenSettings}>
            <Icon name="settings" size={15} /> Settings
            <DropdownMenuShortcut>⌘,</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onOpenStore}>
            <Icon name="plugin" size={15} /> Plugin store
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onSignOut}>
            <Icon name="log-out" size={15} /> Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
        </DropdownMenu>
      )}
    </header>
  );
}
