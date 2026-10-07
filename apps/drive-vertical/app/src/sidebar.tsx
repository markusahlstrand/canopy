/**
 * The shell's left rail, moved from the portal — the rail half of #78's slice 4.
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
 *   - Portal-only space actions (rename, offline files, show-in-my-drive): a space is
 *     a scope now. The current space still offers settings, members and plugins.
 *   - Connector status dots and the indexing spinner: no connectors in the vertical yet
 *     (#57/#58), so there is nothing to probe and no honest colour to show.
 *   - The storage card: it read `STORAGE` out of the portal's mock data. There is no quota
 *     endpoint, and a progress bar over an invented number is worse than no progress bar.
 *   - The user row: the topbar carries the account menu, and one shell needs one of those.
 *
 * `New` stays, because both of its items are real operations.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  CanopyMark,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icon,
  Input,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from '@canopy/ui';
import { openSpace } from './space-navigation';
import { pluginManifest } from './installed-plugins';
import { listSites, type PluginInstall, type Site } from './api';

/** The views this screen has. The portal's Home, Starred and Settings are not among them. */
const NAV = [
  { id: 'drive', icon: 'my-drive', label: 'My Drive' },
  { id: 'search', icon: 'search', label: 'Search' },
  { id: 'shared', icon: 'users', label: 'Shared with me' },
  { id: 'trash', icon: 'trash', label: 'Trash' },
] as const;

export type NavId = (typeof NAV)[number]['id'];

/** Every icon this rail names, so a test can prove none of them falls back to a puzzle piece. */
export const SIDEBAR_ICONS = [
  'my-drive',
  'search',
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
  active: NavId | null;
  onNavigate: (id: NavId) => void;
  onNewFolder: () => void;
  onUpload: () => void;
  offline?: boolean;
  sites: Site[] | null;
  failed: boolean;
  onRetry: () => void;
  /** The mobile sheet always uses the expanded rail. */
  mobile?: boolean;
  onSpaces?: () => void;
  pluginApps?: PluginInstall[];
  activePluginId?: string | null;
  onOpenPlugin?: (id: string) => void;
  onCreateSpace?: () => void;
  canManageSpace?: boolean;
  onSpaceSettings?: () => void;
  onSpaceMembers?: () => void;
  onSpacePlugins?: () => void;
}

/** One space read shared by the desktop rail and the mobile sheet. */
export function useSites() {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [failed, setFailed] = useState(false);
  const request = useRef(0);
  const loaded = useRef(false);
  const inFlight = useRef(false);
  const lastStarted = useRef(0);
  const retry = useCallback(() => {
    const current = ++request.current;
    inFlight.current = true;
    lastStarted.current = Date.now();
    setFailed(false);
    listSites()
      .then(result => { if (request.current === current) { loaded.current = true; setSites(result); } })
      .catch(() => {
        if (request.current !== current) return;
        if (!loaded.current) { setSites([]); setFailed(true); }
      })
      .finally(() => { if (request.current === current) inFlight.current = false; });
  }, []);
  useEffect(() => {
    retry();
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine || inFlight.current || Date.now() - lastStarted.current < 30_000) return;
      retry();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { request.current++; document.removeEventListener('visibilitychange', onVisible); };
  }, [retry]);
  return { sites, failed, retry };
}

function NavRow({
  icon,
  label,
  count,
  dot,
  active,
  collapsed,
  onClick,
  disabled = false,
}: {
  icon: string;
  label: string;
  count?: number;
  dot?: boolean;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  const row = (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-[13.5px] transition-colors',
        disabled && 'opacity-50',
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

export function Sidebar({ active, onNavigate, onNewFolder, onUpload, offline = false, sites, failed, onRetry, mobile = false, onSpaces, onCreateSpace, canManageSpace = false, onSpaceSettings, onSpaceMembers, onSpacePlugins, pluginApps = [], activePluginId = null, onOpenPlugin }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [spaceQuery, setSpaceQuery] = useState('');
  const narrow = mobile ? false : collapsed;
  const spaceTerm = spaceQuery.trim().toLocaleLowerCase();
  const matchesSpace = (site: { name: string; slug: string }) => `${site.name} ${site.slug}`.toLocaleLowerCase().includes(spaceTerm);
  // The current space stays visible: its row carries the only way into space settings.
  const shownSites = sites?.filter(site => site.current || matchesSpace(site));
  const currentSpace = sites?.find(site => site.current);

  const toggle = () =>
    setCollapsed((was) => {
      writeCollapsed(!was);
      return !was;
    });

  return (
    <TooltipProvider>
      <aside className={cn('flex h-full shrink-0 flex-col bg-card', mobile ? 'w-full' : narrow ? 'w-16 border-r' : 'w-60 border-r')}>
        {/* Logo row */}
        <div className={cn('flex h-14 shrink-0 items-center gap-2 px-3', narrow && 'justify-center px-0', mobile && 'pr-12')}>
          <div className="grid size-[26px] shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
            <CanopyMark size={16} />
          </div>
          {!narrow && (
            <>
              <span className="flex-1 text-[15.5px] font-semibold tracking-tight">Canopy</span>
              {!mobile && <button
                onClick={toggle}
                aria-label="Collapse sidebar"
                className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent"
              >
                <Icon name="panel-left" size={16} />
              </button>}
            </>
          )}
        </div>

        {/* New — a folder, or bytes. Both are operations the scope actually has. */}
        <div className={cn('shrink-0 px-3 pb-2', narrow && 'px-2')}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button disabled={offline} className="w-full justify-center gap-1.5" size={narrow ? 'icon' : 'default'}>
                <Icon name="plus" size={16} strokeWidth={2.25} />
                {!narrow && (
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
        <nav className={cn('flex shrink-0 flex-col gap-0.5 px-3', narrow && 'px-2')} aria-label="Views">
          {NAV.map((n) => (
            <NavRow
              key={n.id}
              icon={n.icon}
              label={n.label}
              active={active === n.id}
              collapsed={narrow}
              disabled={offline && n.id !== 'drive'}
              onClick={() => onNavigate(n.id)}
            />
          ))}
        </nav>

        {/*
          Spaces. One row per scope this login is bound in — the switcher, unfolded.

          This is the part that grows, so this is the part that scrolls: with enough
          spaces the rail used to run past the bottom of the shell, taking the expand
          button with it.
        */}
        <div className="min-h-0 flex-1 overflow-y-auto">
        {failed && !narrow && (
          <div className="mt-4 px-3">
            <p className="px-2.5 text-[12px] text-muted-foreground">
              Couldn’t list your spaces.{' '}
              <button onClick={onRetry} className="underline hover:text-foreground">
                Try again
              </button>
            </p>
          </div>
        )}
        {!narrow && (
          <div className="mt-4 px-3">
            <div className="mb-1 flex items-center justify-between px-2.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Spaces
              </span>
              {onCreateSpace && <button
                type="button"
                aria-label="Create space"
                title="Create space"
                disabled={offline}
                onClick={onCreateSpace}
                className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              ><Icon name="plus" size={16} /></button>}
            </div>
            {sites && (sites.length > 5 || spaceQuery) ? <Input aria-label="Filter spaces" placeholder="Filter spaces" value={spaceQuery} onChange={event => setSpaceQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && spaceQuery) { event.stopPropagation(); setSpaceQuery(''); } }} className="mb-2 h-8 text-base md:text-xs" /> : null}
            <nav className="flex flex-col gap-0.5" aria-label="Spaces">
              {shownSites?.map((s) => (
                <div key={s.slug} className="flex items-center gap-0.5">
                <button
                  aria-current={s.current ? 'true' : undefined}
                  disabled={offline}
                  onClick={() => {
                    if (s.current) return;
                    // A full reload rather than a re-render: every read on the screen
                    // belongs to the space it was made in, and re-fetching them piecemeal
                    // is how a listing from one space ends up beside a breadcrumb from
                    // another.
                    //
                    // The URL has to agree with the choice, in BOTH directions, because
                    // `api.ts` reads `?site=` ahead of storage on the next load:
                    //
                    //  - storage refused it → the URL is the only carrier. The slug lives
                    //    in module memory, and the reload is what throws that away, so
                    //    without this a private window reloads into the space you left.
                    //  - storage took it → a `?site=` still in the URL outranks it and the
                    //    reload lands back where the parameter says. Arriving through a
                    //    `?site=` link would pin you to that space: every selection would
                    //    persist correctly and none of them would take effect.
                    openSpace(s.slug);
                  }}
                  className={cn(
                    'flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 text-[13.5px] transition-colors',
                    s.current
                      ? 'bg-accent font-medium text-foreground'
                      : 'text-foreground/80 hover:bg-accent/60',
                  )}
                >
                  <span className={cn('shrink-0', s.current && 'text-primary')}>
                    <Icon name={s.icon ?? "users"} size={17} style={{color:s.color}} />
                  </span>
                  <span className="flex-1 truncate text-left">{s.name}</span>
                </button>
                {s.current && canManageSpace && !offline && (onSpaceSettings || onSpaceMembers || onSpacePlugins) ? <DropdownMenu>
                  <DropdownMenuTrigger asChild><button type="button" aria-label={`Manage ${s.name}`} className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent"><Icon name="more" size={16} /></button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {onSpaceSettings ? <DropdownMenuItem onClick={onSpaceSettings}><Icon name="settings" size={15} /> Space settings</DropdownMenuItem> : null}
                    {onSpaceMembers ? <DropdownMenuItem onClick={onSpaceMembers}><Icon name="users" size={15} /> Manage members</DropdownMenuItem> : null}
                    {onSpacePlugins ? <DropdownMenuItem onClick={onSpacePlugins}><Icon name="plugin" size={15} /> Space plugins</DropdownMenuItem> : null}
                  </DropdownMenuContent>
                </DropdownMenu> : null}
                </div>
              ))}
            </nav>
            {!failed && sites === null ? <p role="status" className="px-2.5 py-1 text-xs text-muted-foreground">Loading spaces…</p> : null}
            {!failed && sites?.length === 0 ? <p className="px-2.5 py-1 text-xs text-muted-foreground">No spaces yet</p> : null}
            {spaceTerm && sites?.length && !sites.some(site => !site.current && matchesSpace(site)) ? <p role="status" className="px-2.5 py-1 text-xs text-muted-foreground">No matching spaces</p> : null}
          </div>
        )}
        {pluginApps.length > 0 && onOpenPlugin ? <div className={cn('mt-4 px-3', narrow && 'px-2')}>
          {!narrow ? <p className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Apps</p> : null}
          <nav aria-label="Plugin apps" className="flex flex-col gap-0.5">
            {pluginApps.map(row => <NavRow key={row.id} icon="plugin" label={pluginManifest(row).contributes.detailView?.title ?? pluginManifest(row).name}
              active={activePluginId === row.id} collapsed={narrow} disabled={offline} onClick={() => onOpenPlugin(row.id)} />)}
          </nav>
        </div> : null}
        </div>

        {onSpaces ? <Button variant="ghost" onClick={onSpaces}
          aria-label={narrow && currentSpace ? `Spaces, current: ${currentSpace.name}` : 'Manage spaces'}
          title={narrow ? currentSpace?.name ?? 'Manage spaces' : undefined}>
          {narrow ? <Icon name={currentSpace?.icon ?? 'users'} style={{ color: currentSpace?.color }} /> : 'Manage spaces'}
        </Button> : null}
        {narrow && (
          <button
            onClick={toggle}
            className="mb-2 grid h-8 shrink-0 place-items-center text-muted-foreground hover:bg-accent"
            aria-label="Expand sidebar"
          >
            <Icon name="panel-left" size={16} />
          </button>
        )}
      </aside>
    </TooltipProvider>
  );
}
