import { Icon } from "@canopy/ui";
import { cn } from "@canopy/ui";
import { Button } from "@canopy/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@canopy/ui";

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
  spaceName?: string;
  onOpenSpaces?: () => void;
  onCrumbClick?: (index: number) => void;
  onOpenMenu: () => void;
  onOpenCmd: () => void;
  /** Absent where nothing can be uploaded (a read-only a3doc space). */
  onUpload?: () => void;
  /** Backend unreachable — the app is view-only, so disable uploads. */
  offline?: boolean;
  /** A deep link has not resolved its destination folder yet. */
  writeBlocked?: boolean;
  /** Force a re-fetch of the current view (re-syncs the offline mirror + reloads). */
  onRefresh?: () => void;
  /** True while a background sync is in flight — spins the refresh icon. */
  syncing?: boolean;
  /**
   * Set only while signed out. On a phone the rail's login sits in the closed navigation sheet,
   * so the topbar offers it too: signed out always shows a way to log in.
   */
  onSignIn?: () => void;
}

export function Topbar({
  breadcrumb,
  spaceName,
  onOpenSpaces,
  onCrumbClick,
  onOpenMenu,
  onOpenCmd,
  onUpload,
  offline,
  writeBlocked,
  onRefresh,
  syncing,
  onSignIn,
}: TopbarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:gap-3 sm:px-4">
      <button
        onClick={onOpenMenu}
        aria-label="Open navigation"
        className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent md:hidden"
      >
        <Icon name="panel-left" size={18} />
      </button>
      {spaceName && onOpenSpaces ? <button type="button" onClick={onOpenSpaces} aria-label={`Spaces, current: ${spaceName}`} className="flex min-w-0 max-w-24 shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent sm:max-w-40">
        <Icon name="users" size={14} className="shrink-0 text-primary" />
        <span className="truncate">{spaceName}</span>
        <Icon name="chevron-down" size={12} className="shrink-0 text-muted-foreground" />
      </button> : null}
      {/* One current folder and a back action fit where a full breadcrumb does not. */}
      <div className="flex min-w-0 flex-1 items-center gap-1 text-sm md:hidden">
        {onCrumbClick && breadcrumb.length > 1 && (
          <button onClick={() => onCrumbClick(breadcrumb.length - 2)} aria-label="Back to parent folder" className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent">
            <Icon name="chevron-left" size={17} />
          </button>
        )}
        <span className="truncate font-semibold" title={breadcrumb.at(-1)}>{breadcrumb.at(-1)}</span>
      </div>
      {/* Breadcrumb */}
      <div className="hidden min-w-0 items-center gap-1.5 text-[14px] md:flex">
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

      <div className="hidden flex-1 md:block" />

      {/* Search trigger */}
      <button
        onClick={onOpenCmd}
        title={offline ? 'Browse saved folders while offline' : undefined}
        aria-label={offline ? 'Browse saved folders' : 'Search or jump to'}
        className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background text-[13.5px] text-muted-foreground transition-colors hover:bg-accent/40 md:w-[280px] md:justify-start md:gap-2 md:px-3"
      >
        <Icon name="search" size={15} />
        <span className="hidden flex-1 text-left md:inline">{offline ? 'Browse saved folders…' : 'Search or jump to…'}</span>
        <kbd className="hidden rounded bg-muted px-1.5 font-mono text-[10.5px] md:inline">⌘</kbd>
        <kbd className="hidden rounded bg-muted px-1.5 font-mono text-[10.5px] md:inline">K</kbd>
      </button>

      {/* Refresh — force a re-sync + reload of the current view */}
      {onRefresh && (
        <button
          onClick={onRefresh}
          title={offline ? "Retry connection" : "Refresh"}
          aria-label="Refresh"
          className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-accent disabled:opacity-50"
        >
          <Icon name="refresh" size={18} className={cn(syncing && "animate-spin")} />
        </button>
      )}

      {/* Upload, absent in a space whose a3doc user can only read; for the rest, whoever holds
          drive:write may upload and the operation refuses everyone else. */}
      {onUpload ? <Button
        onClick={onUpload}
        size="icon"
        disabled={offline || writeBlocked}
        title={offline ? "Unavailable while offline" : writeBlocked ? "Wait for the folder to load" : undefined}
        aria-label="Upload files"
        className="shrink-0 gap-1.5 sm:w-auto sm:px-3"
      >
        <Icon name="upload" size={16} />
        <span className="hidden sm:inline">Upload</span>
      </Button> : null}

      {onSignIn ? <Button onClick={onSignIn} size="sm" disabled={offline} title={offline ? "You're offline" : undefined} className="shrink-0 md:hidden">
        Log in
      </Button> : null}
    </header>
  );
}
