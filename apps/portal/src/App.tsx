import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { FileTable, type SortKey, type SortState, type PluginMenuItem } from "@/components/file-table";
import { PluginRail } from "@/components/plugin-rail";
import { CommandPalette } from "@/components/command-palette";
import { PluginStore } from "@/components/plugin-store";
import { FilePreview } from "@/components/file-preview";
import { HomeView } from "@/components/home-view";
import { TweaksPanel } from "@/components/tweaks-panel";
import { Icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { type FileItem, type FileKind } from "@/lib/mock-data";
import { listFiles, fileUrl, uploadFiles, deleteFile, fetchMe, loginUrl, logout, type Me } from "@/lib/api";
import { createRegistry, DEFAULT_INSTALLED, PLUGIN_UI } from "@/plugins";
import { ACCENT_HSL, ACCENT_HSL_DARK, DEFAULT_TWEAKS, FONT_STACK, type Tweaks } from "@/lib/tweaks";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { DemoBanner } from "@/components/demo-banner";
import { OfflineBanner } from "@/components/offline-banner";

function readUrlState(): { active: string; path: string } {
  const p = new URLSearchParams(window.location.search);
  return { active: p.get("view") ?? "drive", path: p.get("path") ?? "" };
}

function urlForState(active: string, path: string): string {
  const params = new URLSearchParams();
  if (active !== "drive") params.set("view", active);
  if (path) params.set("path", path);
  const qs = params.toString();
  return window.location.pathname + (qs ? `?${qs}` : "");
}

function parseSize(s: string): number {
  const m = s.match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
  if (!m) return 0;
  const units: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
  return parseFloat(m[1]!) * (units[m[2]!.toUpperCase()] ?? 1);
}

function Segmented({ value, onChange }: { value: "list" | "grid"; onChange: (v: "list" | "grid") => void }) {
  return (
    <div className="flex items-center rounded-md border p-0.5">
      {(["list", "grid"] as const).map((v) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={cn(
            "grid size-7 place-items-center rounded-[5px] transition-colors",
            value === v ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon name={v} size={15} />
        </button>
      ))}
    </div>
  );
}

const MobileApp = lazy(() => import("@/mobile/mobile-app").then((m) => ({ default: m.MobileApp })));

export default function App() {
  const isMobile = useIsMobile();
  return (
    <Suspense fallback={<div className="grid h-screen place-items-center text-sm text-muted-foreground">Loading…</div>}>
      {isMobile ? <MobileApp /> : <DesktopApp />}
    </Suspense>
  );
}

function DesktopApp() {
  const [tweaks, setTweaks] = useState<Tweaks>(DEFAULT_TWEAKS);
  const setTweak = <K extends keyof Tweaks>(key: K, value: Tweaks[K]) =>
    setTweaks((t) => ({ ...t, [key]: value }));

  const [installedIds, setInstalledIds] = useState<string[]>(DEFAULT_INSTALLED);
  const registry = useMemo(() => createRegistry(installedIds), [installedIds]);
  const installed = useMemo(() => registry.list().map((r) => r.manifest), [registry]);

  const [active, setActive] = useState(() => readUrlState().active);
  const [activePlugin, setActivePlugin] = useState(() => {
    const a = readUrlState().active;
    return a.startsWith("plugin:") ? a.slice(7) : (installedIds[0] ?? "");
  });
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [view, setView] = useState<"list" | "grid">("list");
  const [sort, setSort] = useState<SortState>({ key: "modified", dir: "desc" });
  const [files, setFiles] = useState<FileItem[]>([]);
  const [path, setPath] = useState(() => readUrlState().path);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const reload = () => setRefreshKey((k) => k + 1);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const [auth, setAuth] = useState<Me>({ user: null, authConfigured: false });
  useEffect(() => {
    fetchMe().then(setAuth);
  }, []);
  const signIn = () => {
    window.location.href = loginUrl(window.location.pathname + window.location.search);
  };
  const signOut = async () => {
    await logout();
    setAuth((a) => ({ ...a, user: null }));
  };

  // Default landing page: Docs when arriving not-signed-in (no explicit ?view=).
  // Applied once when auth first resolves; doesn't lock navigation afterwards.
  const initialHadView = useMemo(() => new URLSearchParams(window.location.search).has("view"), []);
  const docsDefaultApplied = useRef(false);
  useEffect(() => {
    if (docsDefaultApplied.current || !auth.authConfigured) return;
    docsDefaultApplied.current = true;
    if (!auth.user && !initialHadView) {
      setActive("plugin:docs");
      setActivePlugin("docs");
    }
  }, [auth, initialHadView]);

  const [cmdOpen, setCmdOpen] = useState(false);
  const [storeOpen, setStoreOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Apply theme + accent + font to the document root.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", tweaks.theme === "dark");
    const accent = (tweaks.theme === "dark" ? ACCENT_HSL_DARK : ACCENT_HSL)[tweaks.accent] ?? ACCENT_HSL.green!;
    root.style.setProperty("--primary", accent);
    root.style.setProperty("--ring", accent);
    root.style.setProperty("--font-sans", FONT_STACK[tweaks.font] ?? FONT_STACK.geist!);
  }, [tweaks.theme, tweaks.accent, tweaks.font]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "j") {
        e.preventDefault();
        setTweak("theme", tweaks.theme === "dark" ? "light" : "dark");
      } else if (e.key === "Escape") {
        setSelection(new Set());
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [tweaks.theme]);

  // Reflect the current view + folder in the URL so refresh and back/forward work.
  useEffect(() => {
    const url = urlForState(active, path);
    if (url !== window.location.pathname + window.location.search) {
      window.history.pushState(null, "", url);
    }
  }, [active, path]);

  useEffect(() => {
    function onPop() {
      const s = readUrlState();
      setActive(s.active);
      setPath(s.path);
      setSelection(new Set());
      if (s.active.startsWith("plugin:")) setActivePlugin(s.active.slice(7));
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Load real files from the local connector whenever the current path changes.
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    listFiles(path)
      .then((items) => {
        if (cancelled) return;
        setFiles(items);
        setSelection(new Set());
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setFiles([]);
        setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [path, refreshKey]);

  function openItem(f: FileItem) {
    if (f.kind === "folder" && f.path != null) setPath(f.path);
    else setPreviewFile(f);
  }

  function onCrumbClick(index: number) {
    setPath(index === 0 ? "" : path.split("/").filter(Boolean).slice(0, index).join("/"));
    setSelection(new Set());
  }

  async function upload(fileList: FileList | null) {
    const files = fileList ? Array.from(fileList) : [];
    if (files.length === 0) return;
    toast("Upload started", { description: `${files.length} file(s) → ${path || "My Drive"}` });
    try {
      await uploadFiles(path, files);
      reload();
      toast(`${files.length} file(s) uploaded`);
    } catch (err) {
      toast("Upload failed", { description: (err as Error).message });
    }
  }

  const sortedFiles = useMemo(() => {
    const arr = [...files];
    const dir = sort.dir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      if (a.kind === "folder" && b.kind !== "folder") return -1;
      if (b.kind === "folder" && a.kind !== "folder") return 1;
      if (sort.key === "name") return dir * a.name.localeCompare(b.name);
      if (sort.key === "modified") return dir * (+new Date(a.modified) - +new Date(b.modified));
      if (sort.key === "size") return dir * (parseSize(a.size) - parseSize(b.size));
      return dir * ((a.sharedWith?.length ?? 0) - (b.sharedWith?.length ?? 0));
    });
    return arr;
  }, [files, sort]);

  function onSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  }

  function navigate(id: string) {
    setActive(id);
    setSelection(new Set());
    if (id === "drive") setPath("");
    if (id.startsWith("plugin:")) setActivePlugin(id.replace("plugin:", ""));
  }

  function installPlugin(id: string) {
    if (installedIds.includes(id)) return;
    setInstalledIds((ids) => [...ids, id]);
    setActivePlugin(id);
    const name = registry.get(id)?.manifest.name ?? id;
    toast(`${name} installed`, { description: "Open it from the right rail or sidebar." });
  }

  async function deleteSelected() {
    const targets = files.filter((f) => selection.has(f.id) && f.path != null);
    const n = targets.length;
    setSelection(new Set());
    try {
      await Promise.all(targets.map((f) => deleteFile(f.path!)));
      reload();
      toast(`${n} item${n === 1 ? "" : "s"} deleted`);
    } catch (err) {
      toast("Delete failed", { description: (err as Error).message });
      reload();
    }
  }

  async function onFileAction(action: string, f: FileItem) {
    if (action === "Delete") {
      if (f.path == null) return;
      try {
        await deleteFile(f.path);
        reload();
        toast("1 item deleted", { description: f.name });
      } catch (err) {
        toast("Delete failed", { description: (err as Error).message });
      }
    } else if (action === "Star") {
      setFiles((fs) => fs.map((x) => (x.id === f.id ? { ...x, starred: !x.starred } : x)));
    } else if ((action === "Download" || action === "Copy link") && f.path != null) {
      window.open(fileUrl(f.path), "_blank");
    } else {
      toast(action, { description: f.name });
    }
  }

  const pluginMenuItems = (kind: FileKind): PluginMenuItem[] =>
    registry.contextMenuItems(kind).map((e) => ({ pluginId: e.pluginId, label: e.item.label, icon: e.item.icon }));

  const isFilesView = active === "drive" || active === "family" || active === "starred";
  const visibleFiles =
    active === "starred"
      ? sortedFiles.filter((f) => f.starred)
      : active === "family"
        ? sortedFiles.filter((f) => (f.sharedWith?.length ?? 0) > 1)
        : sortedFiles;

  const title =
    active === "family"
      ? "Shared with family"
      : active === "starred"
        ? "Starred"
        : path
          ? (path.split("/").filter(Boolean).pop() ?? "Recent")
          : "Recent";

  const breadcrumb =
    active === "home"
      ? ["Home"]
      : active === "family"
        ? ["Family", "Shared"]
        : active === "starred"
          ? ["Starred"]
          : active === "trash"
            ? ["Trash"]
            : active.startsWith("plugin:")
              ? [installed.find((p) => `plugin:${p.id}` === active)?.name ?? "Plugin"]
              : path
                ? ["My Drive", ...path.split("/").filter(Boolean)]
                : ["My Drive", "All files"];

  const showRail = tweaks.showRail && installed.length > 0 && active !== "home";

  return (
    <div className="flex h-screen flex-col">
      <OfflineBanner />
      <DemoBanner auth={auth} onSignIn={signIn} />
      <div
      className={cn(
        "app-grid min-h-0 flex-1",
        tweaks.sidebarCollapsed && "collapsed-sb",
        !showRail && "no-rail",
        tweaks.density !== "default" && `density-${tweaks.density}`,
        tweaks.radius !== "default" && `radius-${tweaks.radius}`,
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        void upload(e.dataTransfer.files);
      }}
    >
      <Sidebar
        active={active}
        onNavigate={navigate}
        installedPlugins={installed}
        onOpenStore={() => setStoreOpen(true)}
        collapsed={tweaks.sidebarCollapsed}
        onToggle={() => setTweak("sidebarCollapsed", !tweaks.sidebarCollapsed)}
        auth={auth}
        onSignIn={signIn}
        onSignOut={signOut}
      />

      <div className="flex min-w-0 flex-col overflow-hidden">
        <Topbar
          breadcrumb={breadcrumb}
          onCrumbClick={active === "drive" ? onCrumbClick : undefined}
          onOpenCmd={() => setCmdOpen(true)}
          onOpenStore={() => setStoreOpen(true)}
          theme={tweaks.theme}
          onToggleTheme={() => setTweak("theme", tweaks.theme === "dark" ? "light" : "dark")}
          onUpload={() => uploadInputRef.current?.click()}
          auth={auth}
          onSignIn={signIn}
          onSignOut={signOut}
        />

        <main className="relative flex-1 overflow-auto">
          <div className="mx-auto max-w-[1280px] px-8 pb-8 pt-[22px]">
            {active === "home" ? (
              <HomeView installed={installed} files={files} onOpenPlugin={(id) => navigate(`plugin:${id}`)} onOpenFile={setPreviewFile} />
            ) : active === "trash" ? (
              <EmptyState />
            ) : active.startsWith("plugin:") ? (
              <PluginDetail id={active.replace("plugin:", "")} installed={installed} />
            ) : isFilesView ? (
              <>
                <div className="mb-4 flex flex-wrap items-center gap-3">
                  <div className="min-w-0">
                    <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
                    <div className="mt-0.5 whitespace-nowrap font-mono text-[13px] text-muted-foreground">
                      {visibleFiles.length} item{visibleFiles.length === 1 ? "" : "s"}
                      {selection.size > 0 ? ` · ${selection.size} selected` : ""}
                    </div>
                  </div>
                  <div className="flex-1" />
                  {selection.size > 0 ? (
                    <>
                      <Button variant="outline" size="sm" className="gap-1.5">
                        <Icon name="share" size={14} /> Share
                      </Button>
                      <Button variant="outline" size="sm" className="gap-1.5">
                        <Icon name="download" size={14} /> Download
                      </Button>
                      <Button variant="outline" size="sm" className="gap-1.5" onClick={deleteSelected}>
                        <Icon name="trash" size={14} /> Delete
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setSelection(new Set())}>
                        Clear
                      </Button>
                    </>
                  ) : (
                    <>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="outline" size="sm" className="gap-1.5">
                            <Icon name="filter" size={14} /> Filter
                            <Icon name="chevron-down" size={12} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuLabel>Filter by type</DropdownMenuLabel>
                          <DropdownMenuItem>Folders</DropdownMenuItem>
                          <DropdownMenuItem>Images</DropdownMenuItem>
                          <DropdownMenuItem>PDFs</DropdownMenuItem>
                          <DropdownMenuItem>Notes</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem>Starred only</DropdownMenuItem>
                          <DropdownMenuItem>Shared with me</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <Segmented value={view} onChange={setView} />
                    </>
                  )}
                </div>
                {loadError ? (
                  <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                    Couldn't reach the storage API. Start it with <code className="font-mono">pnpm dev:api</code>.
                    <div className="mt-1 font-mono text-[12px]">{loadError}</div>
                  </div>
                ) : (
                  <FileTable
                    files={visibleFiles}
                    selection={selection}
                    onSelectionChange={setSelection}
                    onOpen={openItem}
                    onAction={onFileAction}
                    pluginMenuItems={pluginMenuItems}
                    sort={sort}
                    onSort={onSort}
                    view={view}
                  />
                )}
              </>
            ) : null}
          </div>

          {dragOver && (
            <div className="pointer-events-none absolute inset-3 z-40 grid place-items-center rounded-lg border-2 border-dashed border-primary bg-primary/[0.06]">
              <div className="flex flex-col items-center gap-2 text-primary">
                <Icon name="upload" size={36} />
                <div className="text-[16px] font-semibold">Drop files to upload</div>
                <div className="text-sm text-muted-foreground">They'll land in {breadcrumb.join(" / ")}</div>
              </div>
            </div>
          )}
        </main>
      </div>

      {showRail && <PluginRail installed={installed} active={activePlugin} onChange={setActivePlugin} />}

      <CommandPalette
        open={cmdOpen}
        onOpenChange={setCmdOpen}
        files={files}
        installedIds={installedIds}
        onNavigate={navigate}
        onOpenFile={setPreviewFile}
        onOpenStore={() => setStoreOpen(true)}
        onToggleTheme={() => setTweak("theme", tweaks.theme === "dark" ? "light" : "dark")}
      />

      <PluginStore open={storeOpen} onOpenChange={setStoreOpen} installedIds={installedIds} onInstall={installPlugin} />

      <FilePreview file={previewFile} onClose={() => setPreviewFile(null)} />

      <TweaksPanel t={tweaks} setTweak={setTweak} />

      <input
        ref={uploadInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void upload(e.target.files);
          e.target.value = "";
        }}
      />

      <Toaster position="bottom-right" />
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="grid place-items-center py-24 text-center">
      <div className="grid size-16 place-items-center rounded-2xl bg-muted text-muted-foreground">
        <Icon name="trash" size={28} strokeWidth={1.25} />
      </div>
      <div className="mt-4 text-[16px] font-semibold">Nothing here</div>
      <div className="mt-1 max-w-sm text-sm text-muted-foreground">
        Files in Trash are removed after 30 days. Anything you delete will show up here first.
      </div>
    </div>
  );
}

function PluginDetail({ id, installed }: { id: string; installed: { id: string; name: string; icon?: string; color?: string; contributes?: { store?: { tagline: string } } }[] }) {
  const manifest = installed.find((p) => p.id === id);
  const DetailView = PLUGIN_UI[id]?.DetailView;
  if (!manifest) return null;
  return (
    <div>
      <div className="mb-5 flex items-center gap-3.5">
        <div
          className="grid size-11 place-items-center rounded-md"
          style={{ background: `hsl(${manifest.color} / 0.14)`, color: `hsl(${manifest.color})` }}
        >
          <Icon name={manifest.icon ?? "plugin"} size={20} />
        </div>
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">{manifest.name}</h1>
          <div className="text-sm text-muted-foreground">{manifest.contributes?.store?.tagline}</div>
        </div>
      </div>
      {DetailView ? (
        <Suspense fallback={<div className="py-20 text-center text-sm text-muted-foreground">Loading…</div>}>
          <DetailView />
        </Suspense>
      ) : (
        <div className="grid place-items-center py-20 text-center">
          <div className="text-[15px] font-semibold">{manifest.name} is ready</div>
          <div className="mt-1 text-sm text-muted-foreground">This plugin's full view is still being designed.</div>
        </div>
      )}
    </div>
  );
}
