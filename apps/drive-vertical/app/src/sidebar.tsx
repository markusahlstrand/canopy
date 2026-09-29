/**
 * The shell's left rail, moved from the portal (S12a slice 6, #78).
 *
 * It lists the SPACES this login is bound in, which is the decision this file records:
 * the topbar's `<select>` switcher and a space list in the sidebar are two ways to change
 * space in one shell, so the sidebar keeps that job and the switcher is gone. What the
 * old header did in a dropdown, the rail now does as rows you can see without opening
 * anything — and a space you cannot see is a space you forget you have.
 *
 * The rest is the portal's rail with everything cut that has nothing behind it here:
 *
 *   - Home, Starred and Settings: no such screens. The nav is the two views the drive has.
 *   - Per-space context menus (rename, members, offline files, show-in-my-drive): those
 *     were portal-side space records. A space is a scope now, provisioned by the platform,
 *     and renaming or sharing one is #79's, not a menu item that throws.
 *   - Connector status dots and the indexing spinner: no connectors in the vertical yet
 *     (#57/#58), so there is nothing to probe and no honest colour to show.
 *   - Plugin launchers: the plugin seam is #73.
 *   - The storage card: it read `STORAGE` out of the portal's mock data. There is no quota
 *     endpoint, and a progress bar over an invented number is worse than no progress bar.
 *   - The user row: the topbar carries the account menu, and one shell needs one of those.
 *
 * `New` stays, because both of its items are real operations.
 */
import { useEffect, useState } from 'react';
import {
  Button,
  CanopyMark,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icon,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from '@canopy/ui';
import { listSites, selectSite, type Site } from './api';

/** The views this screen has. The portal's Home, Starred and Settings are not among them. */
const NAV = [
  { id: 'drive', icon: 'my-drive', label: 'My Drive' },
  { id: 'trash', icon: 'trash', label: 'Trash' },
] as const;

export type NavId = (typeof NAV)[number]['id'];

/** Every icon this rail names, so a test can prove none of them falls back to a puzzle piece. */
export const SIDEBAR_ICONS = [
  'my-drive',
  'trash',
  'panel-left',
  'plus',
  'chevron-down',
  'folder',
  'upload',
  'users',
] as const;

/** Collapsed-or-not outlives a reload, the way it did in the portal's settings. */
const COLLAPSE_KEY = 'canopy.drive.sidebar-collapsed';

const readCollapsed = (): boolean => {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    // Private mode, blocked site data: expanded, and it stays that way for the tab.
    return false;
  }
};

const writeCollapsed = (collapsed: boolean): void => {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  } catch {
    // A preference nobody can store is still a preference for this tab.
  }
};

interface SidebarProps {
  /** Which view the screen is showing, so the matching row reads as active. */
  active: NavId;
  onNavigate: (id: NavId) => void;
  onNewFolder: () => void;
  onUpload: () => void;
  /** Listing the spaces can fail without the drive failing; the shell says so. */
  onError: (message: string | null) => void;
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
        'flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-[13.5px] transition-colors',
        collapsed && 'justify-center px-0',
        active ? 'bg-accent font-medium text-foreground' : 'text-foreground/80 hover:bg-accent/60',
      )}
    >
      <span className={cn('shrink-0', active && 'text-primary')}>
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

export function Sidebar({ active, onNavigate, onNewFolder, onUpload, onError }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [sites, setSites] = useState<Site[] | null>(null);

  const toggle = () =>
    setCollapsed((was) => {
      writeCollapsed(!was);
      return !was;
    });

  useEffect(() => {
    listSites()
      .then(setSites)
      .catch((e: unknown) => {
        // Not the screen's failure: the drive still renders against whatever space the
        // hostname routed to. Say it and carry on with no list.
        onError(e instanceof Error ? e.message : String(e));
        setSites([]);
      });
  }, [onError]);

  return (
    <TooltipProvider>
      <aside className={cn('flex h-full shrink-0 flex-col border-r bg-card', collapsed ? 'w-16' : 'w-60')}>
        {/* Logo row */}
        <div className={cn('flex h-14 items-center gap-2 px-3', collapsed && 'justify-center px-0')}>
          <div className="grid size-[26px] shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
            <CanopyMark size={16} />
          </div>
          {!collapsed && (
            <>
              <span className="flex-1 text-[15.5px] font-semibold tracking-tight">Canopy</span>
              <button
                onClick={toggle}
                aria-label="Collapse sidebar"
                className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent"
              >
                <Icon name="panel-left" size={16} />
              </button>
            </>
          )}
        </div>

        {/* New — a folder, or bytes. Both are operations the scope actually has. */}
        <div className={cn('px-3 pb-2', collapsed && 'px-2')}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="w-full justify-center gap-1.5" size={collapsed ? 'icon' : 'default'}>
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
        <nav className={cn('flex flex-col gap-0.5 px-3', collapsed && 'px-2')} aria-label="Views">
          {NAV.map((n) => (
            <NavRow
              key={n.id}
              icon={n.icon}
              label={n.label}
              active={active === n.id}
              collapsed={collapsed}
              onClick={() => onNavigate(n.id)}
            />
          ))}
        </nav>

        {/* Spaces. One row per scope this login is bound in — the switcher, unfolded. */}
        {!collapsed && sites && sites.length > 0 && (
          <div className="mt-4 px-3">
            <div className="mb-1 flex items-center justify-between px-2.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Spaces
              </span>
            </div>
            <nav className="flex flex-col gap-0.5" aria-label="Spaces">
              {sites.map((s) => (
                <button
                  key={s.slug}
                  aria-current={s.current ? 'true' : undefined}
                  onClick={() => {
                    if (s.current) return;
                    selectSite(s.slug);
                    // A full reload rather than a re-render: every read on the screen
                    // belongs to the space it was made in, and re-fetching them piecemeal
                    // is how a listing from one space ends up beside a breadcrumb from
                    // another.
                    window.location.reload();
                  }}
                  className={cn(
                    'flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-[13.5px] transition-colors',
                    s.current
                      ? 'bg-accent font-medium text-foreground'
                      : 'text-foreground/80 hover:bg-accent/60',
                  )}
                >
                  <span className={cn('shrink-0', s.current && 'text-primary')}>
                    <Icon name="users" size={17} />
                  </span>
                  <span className="flex-1 truncate text-left">{s.name}</span>
                </button>
              ))}
            </nav>
          </div>
        )}

        {/* Spacer keeps the expand button on the floor. */}
        <div className="min-h-4 flex-1" />

        {collapsed && (
          <button
            onClick={toggle}
            className="mb-2 grid h-8 place-items-center text-muted-foreground hover:bg-accent"
            aria-label="Expand sidebar"
          >
            <Icon name="panel-left" size={16} />
          </button>
        )}
      </aside>
    </TooltipProvider>
  );
}
