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

function initialsOf(s: string): string {
  const parts = s.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "U";
}

interface TopbarProps {
  breadcrumb: string[];
  onCrumbClick?: (index: number) => void;
  onOpenCmd: () => void;
  onOpenStore: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onUpload: () => void;
  /** Hide the Upload button in a read-only (connected) space. */
  readonly?: boolean;
  railAvailable: boolean;
  railOpen: boolean;
  onToggleRail: () => void;
  auth: Me;
  onSignIn: () => void;
  onSignOut: () => void;
  /** Backend unreachable — the app is view-only, so disable uploads. */
  offline?: boolean;
}

export function Topbar({
  breadcrumb,
  onCrumbClick,
  onOpenCmd,
  onOpenStore,
  theme,
  onToggleTheme,
  onUpload,
  readonly,
  railAvailable,
  railOpen,
  onToggleRail,
  auth,
  onSignIn,
  onSignOut,
  offline,
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
      <div className="flex items-center gap-1.5 text-[14px]">
        {breadcrumb.map((crumb, i) => {
          const last = i === breadcrumb.length - 1;
          return (
            <span key={i} className="flex items-center gap-1.5">
              {onCrumbClick && !last ? (
                <button onClick={() => onCrumbClick(i)} className="text-muted-foreground hover:text-foreground">
                  {crumb}
                </button>
              ) : (
                <span className={last ? "font-semibold" : "text-muted-foreground"}>{crumb}</span>
              )}
              {!last && <span className="text-muted-foreground/60">›</span>}
            </span>
          );
        })}
      </div>

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
          <DropdownMenuItem>
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
