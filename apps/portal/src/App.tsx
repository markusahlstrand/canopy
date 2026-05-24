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
import { FileIcon } from "@/components/file-icon";
import { PluginRail } from "@/components/plugin-rail";
import { CommandPalette } from "@/components/command-palette";
import { PluginStore } from "@/components/plugin-store";
import { FilePreview } from "@/components/file-preview";
import { ShareDialog } from "@/components/share-dialog";
import { HomeView } from "@/components/home-view";
import { BuildPluginView } from "@/components/build-plugin-view";
import { SettingsView } from "@/components/settings-view";
import { TweaksPanel } from "@/components/tweaks-panel";
import { Icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { type FileItem, type FileKind, PLUGIN_CATALOG } from "@/lib/mock-data";
import type { InstalledCreator } from "@/plugins/viewers";
import {
  listFiles,
  listShared,
  listSpaces,
  createSpace,
  renameSpace,
  createFolder,
  createFile,
  getOverview,
  contentUrl,
  uploadFiles,
  deleteFile,
  listTrash,
  restoreFile,
  purgeFile,
  setStarred,
  moveFile,
  setSpaceMounted,
  fetchMe,
  fetchInstalledPlugins,
  fetchActivePlugins,
  saveInstalledPlugins,
  loginUrl,
  logout,
  type Me,
  type Role,
  type SpaceView,
  type Overview,
  type ShareTarget,
} from "@/lib/api";
import { SpaceMembersDialog } from "@/components/space-members-dialog";
import { PluginSettingsDialog } from "@/components/plugin-settings-dialog";
import { InviteGate } from "@/components/invite-gate";
import { ConnectDeviceDialog } from "@/components/connect-device-dialog";
import { createRegistry, ANON_DEFAULT_INSTALLED, DOCS_PLUGIN_ID, PLUGIN_UI } from "@/plugins";
import { sandboxedSlot } from "@/plugins/ui";
import { PluginSlot } from "@/components/plugin-slot";
import { PluginDataProvider, usePluginCapabilities } from "@/plugins/data";
import { ACCENT_HSL, ACCENT_HSL_DARK, DEFAULT_TWEAKS, FONT_STACK, type Tweaks } from "@/lib/tweaks";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { DemoBanner } from "@/components/demo-banner";
import { InviteBanner } from "@/components/invite-banner";
import { OfflineBanner } from "@/components/offline-banner";
import { ErrorBoundary } from "@/components/error-boundary";

function readUrlState(): { active: string; path: string; space: string } {
  const p = new URLSearchParams(window.location.search);
  return { active: p.get("view") ?? "drive", path: p.get("path") ?? "", space: p.get("space") ?? "" };
}

function urlForState(active: string, path: string, space: string): string {
  const params = new URLSearchParams();
  if (active !== "drive") params.set("view", active);
  if (space) params.set("space", space);
  if (path) params.set("path", path);
  // The Documentation view owns a `?doc=` page param. Preserve it while that view
  // is open so deep links survive the app's own URL writes (it's naturally dropped
  // when you navigate elsewhere, since active is no longer the docs plugin).
  if (active === `plugin:${DOCS_PLUGIN_ID}`) {
    const doc = new URLSearchParams(window.location.search).get("doc");
    if (doc) params.set("doc", doc);
  }
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
    // Keyed by layout so a crash in one tree resets when the viewport flips to the other.
    <ErrorBoundary key={isMobile ? "mobile" : "desktop"}>
      <Suspense fallback={<div className="grid h-screen place-items-center text-sm text-muted-foreground">Loading…</div>}>
        {isMobile ? <MobileApp /> : <DesktopApp />}
        <InviteGate />
      </Suspense>
    </ErrorBoundary>
  );
}

function DesktopApp() {
  const [tweaks, setTweaks] = useState<Tweaks>(() => {
    try {
      const saved = localStorage.getItem("canopy.tweaks");
      return saved ? { ...DEFAULT_TWEAKS, ...(JSON.parse(saved) as Partial<Tweaks>) } : DEFAULT_TWEAKS;
    } catch {
      return DEFAULT_TWEAKS;
    }
  });
  const setTweak = <K extends keyof Tweaks>(key: K, value: Tweaks[K]) =>
    setTweaks((t) => ({ ...t, [key]: value }));
  // Persist UI preferences (theme, rail open/closed, density…) across reloads.
  useEffect(() => {
    try {
      localStorage.setItem("canopy.tweaks", JSON.stringify(tweaks));
    } catch {
      /* storage unavailable — preferences just won't persist */
    }
  }, [tweaks]);

  // Start with the anonymous default (includes Documentation). Once auth resolves
  // to a signed-in user, Documentation drops to an optional store plugin (below).
  // Two sets: `installedIds` is the caller's personal installs (what the store
  // toggles); `activeServerIds` is the server's *effective* set — installs unioned
  // with every plugin an owner applied to a space the caller belongs to. The
  // registry renders the union, so a space-applied plugin lights up even though it
  // isn't personally installed, and a local install/uninstall reflects instantly.
  const [installedIds, setInstalledIds] = useState<string[]>(ANON_DEFAULT_INSTALLED);
  const [activeServerIds, setActiveServerIds] = useState<string[]>(ANON_DEFAULT_INSTALLED);
  const activeIds = useMemo(
    () => [...new Set([...installedIds, ...activeServerIds])],
    [installedIds, activeServerIds],
  );
  const registry = useMemo(() => createRegistry(activeIds), [activeIds]);
  const installed = useMemo(() => registry.list().map((r) => r.manifest), [registry]);
  const refreshActive = () => fetchActivePlugins().then((ids) => ids && setActiveServerIds(ids));

  const [active, setActive] = useState(() => readUrlState().active);
  const [activePlugin, setActivePlugin] = useState(() => {
    const a = readUrlState().active;
    return a.startsWith("plugin:") ? a.slice(7) : (installedIds[0] ?? "");
  });
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [view, setView] = useState<"list" | "grid">("list");
  const [sort, setSort] = useState<SortState>({ key: "modified", dir: "desc" });
  const [files, setFiles] = useState<FileItem[]>([]);
  const [trashFiles, setTrashFiles] = useState<FileItem[]>([]);
  const [path, setPath] = useState(() => readUrlState().path);
  // "" = personal space, "shared" = files shared with me, else a group space id.
  const [space, setSpace] = useState(() => readUrlState().space);
  const [spaces, setSpaces] = useState<SpaceView[]>([]);
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

  // Load the persisted install set. Anonymous visitors get null (can't persist) and
  // keep the optimistic anonymous default seeded above (Documentation included).
  useEffect(() => {
    fetchInstalledPlugins().then((ids) => {
      if (ids) setInstalledIds(ids);
    });
    void refreshActive();
  }, []);

  // Whether installs can be saved: signed-in, or demo mode (auth off → shared
  // "demo" user). Anonymous-with-auth callers can't, so we skip the round-trip.
  const canPersist = !auth.authConfigured || !!auth.user;
  function persistInstalled(next: string[]) {
    setInstalledIds(next);
    if (canPersist) saveInstalledPlugins(next).catch(() => {});
  }

  // Documentation is the signed-out landing page. Applied once when auth first
  // resolves; doesn't lock navigation afterwards. (Whether it's *installed* is
  // server-driven — it ships only for anonymous/demo visitors.)
  const initialHadView = useMemo(() => new URLSearchParams(window.location.search).has("view"), []);
  const docsLandingApplied = useRef(false);
  useEffect(() => {
    if (docsLandingApplied.current || !auth.authConfigured) return;
    docsLandingApplied.current = true;
    if (!auth.user && !initialHadView) {
      setActive(`plugin:${DOCS_PLUGIN_ID}`);
      setActivePlugin(DOCS_PLUGIN_ID);
    }
  }, [auth, initialHadView]);

  const [cmdOpen, setCmdOpen] = useState(false);
  const [storeOpen, setStoreOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  // How an opened file is shown: "split" docks beside the (still-usable) list,
  // "full" covers the viewport. Remembered across files and reloads.
  const [previewMode, setPreviewMode] = useState<"split" | "full">(() =>
    localStorage.getItem("canopy.previewMode") === "full" ? "full" : "split",
  );
  const togglePreviewMode = () =>
    setPreviewMode((m) => {
      const next = m === "split" ? "full" : "split";
      try {
        localStorage.setItem("canopy.previewMode", next);
      } catch {
        /* storage unavailable — just won't persist */
      }
      return next;
    });
  const [shareTarget, setShareTarget] = useState<{ target: ShareTarget; label: string } | null>(null);
  const [membersSpace, setMembersSpace] = useState<{ id: string; name: string; role: Role } | null>(null);
  const [settingsPlugin, setSettingsPlugin] = useState<{ id: string; name: string } | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [overview, setOverview] = useState<Overview>({ files: 0, bytes: 0 });
  const [sharedCount, setSharedCount] = useState(0);
  const [dragOver, setDragOver] = useState(false);

  // Dashboard stats (personal space): file count, bytes used, and how many files
  // are shared with me. Refreshed alongside the drive.
  useEffect(() => {
    getOverview()
      .then(setOverview)
      .catch(() => setOverview({ files: 0, bytes: 0 }));
    listShared()
      .then((s) => setSharedCount(s.length))
      .catch(() => setSharedCount(0));
  }, [refreshKey, auth.user, auth.authConfigured]);

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
        if (previewFile) return; // the open preview owns Escape (it closes itself)
        setSelection(new Set());
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [tweaks.theme, previewFile]);

  // Reflect the current view + space + folder in the URL so refresh / back-forward work.
  useEffect(() => {
    const url = urlForState(active, path, space);
    if (url !== window.location.pathname + window.location.search) {
      window.history.pushState(null, "", url);
    }
  }, [active, path, space]);

  useEffect(() => {
    function onPop() {
      const s = readUrlState();
      setActive(s.active);
      setPath(s.path);
      setSpace(s.space);
      setSelection(new Set());
      if (s.active.startsWith("plugin:")) setActivePlugin(s.active.slice(7));
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // The spaces the user can see (personal + groups), for mounting + the switcher.
  useEffect(() => {
    listSpaces()
      .then(setSpaces)
      .catch(() => setSpaces([]));
  }, [refreshKey, auth.user, auth.authConfigured]);

  // Re-fetch spaces + shared count when the tab regains focus, so a space shared
  // with you while you're away shows up without a manual reload.
  useEffect(() => {
    if (!auth.user) return;
    const refreshShares = () => {
      listSpaces().then(setSpaces).catch(() => {});
      listShared().then((s) => setSharedCount(s.length)).catch(() => {});
    };
    const onVisible = () => document.visibilityState === "visible" && refreshShares();
    window.addEventListener("focus", refreshShares);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refreshShares);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [auth.user]);

  // Notify once (per device) when a group space has been newly shared with you —
  // a space you don't own that you haven't seen before. Diffed against a
  // localStorage baseline so it fires for genuinely new shares, not every load.
  useEffect(() => {
    if (!auth.user) return;
    const key = `canopy:seen-shares:${auth.user.sub}`;
    const sharedToMe = spaces.filter((s) => s.kind === "group" && s.role !== "owner");
    if (sharedToMe.length === 0) return;
    let seen: Set<string>;
    try {
      seen = new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
    } catch {
      seen = new Set();
    }
    const fresh = sharedToMe.filter((s) => !seen.has(s.id));
    if (fresh.length === 0) return;
    for (const s of fresh) {
      toast("Shared with you", { description: `You were added to "${s.name}".` });
      seen.add(s.id);
    }
    localStorage.setItem(key, JSON.stringify([...seen]));
  }, [spaces, auth.user]);

  // Load the current location. At the personal root, mounted group spaces appear
  // as folders (the merged "family" feel) alongside a "Shared with me" entry.
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    const load = space === "shared" ? listShared() : listFiles(path, space || undefined);
    load
      .then((items) => {
        if (cancelled) return;
        let composed = items;
        if (space === "" && path === "") {
          const mounts: FileItem[] = spaces
            .filter((s) => s.kind === "group" && s.mounted)
            .map((s) => ({ id: `space:${s.id}`, name: s.name, kind: "folder", modified: "—", size: "—" }));
          composed = [
            ...mounts,
            { id: "__shared", name: "Shared with me", kind: "folder", modified: "—", size: "—" },
            ...items,
          ];
        }
        setFiles(composed);
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
  }, [space, path, refreshKey, spaces]);

  // Load Trash when the Trash view is open (and on refresh after restore/purge).
  useEffect(() => {
    if (active !== "trash") return;
    let cancelled = false;
    listTrash()
      .then((items) => !cancelled && setTrashFiles(items))
      .catch(() => !cancelled && setTrashFiles([]));
    return () => {
      cancelled = true;
    };
  }, [active, refreshKey]);

  function openSpace(id: string) {
    setActive("drive");
    setSpace(id);
    setPath("");
    setSelection(new Set());
  }

  async function togglePin(id: string, mounted: boolean) {
    try {
      await setSpaceMounted(id, mounted);
      setSpaces(await listSpaces());
    } catch (err) {
      toast("Couldn't update", { description: (err as Error).message });
    }
  }

  function openItem(f: FileItem) {
    if (f.id.startsWith("space:")) return openSpace(f.id.slice(6)); // a mounted group space
    if (f.id === "__shared") return openSpace("shared"); // "Shared with me"
    if (f.kind === "folder" && f.path != null) setPath(f.path);
    else setPreviewFile(f);
  }

  function onCrumbClick(index: number) {
    setPath(index === 0 ? "" : path.split("/").filter(Boolean).slice(0, index).join("/"));
    setSelection(new Set());
  }

  async function createSpaceFlow() {
    const name = window.prompt("Name your shared space (e.g. Family)");
    if (!name?.trim()) return;
    try {
      const s = await createSpace(name.trim());
      setSpaces(await listSpaces());
      openSpace(s.id);
      toast(`Created “${name.trim()}”`, { description: "Share files into it or add members." });
    } catch (err) {
      toast("Couldn't create space", { description: (err as Error).message });
    }
  }

  async function renameSpaceFlow(id: string) {
    const current = spaces.find((s) => s.id === id);
    const name = window.prompt("Rename space", current?.name ?? "");
    if (!name?.trim() || name.trim() === current?.name) return;
    try {
      await renameSpace(id, name.trim());
      setSpaces(await listSpaces());
      toast(`Renamed to “${name.trim()}”`);
    } catch (err) {
      toast("Couldn't rename space", { description: (err as Error).message });
    }
  }

  async function createFolderFlow() {
    if (space === "shared") {
      toast("Open a drive or space to create a folder");
      return;
    }
    const name = window.prompt("Folder name");
    if (!name?.trim()) return;
    try {
      await createFolder([path, name.trim()].filter(Boolean).join("/"), space || undefined);
      reload();
      toast(`Created “${name.trim()}”`);
    } catch (err) {
      toast("Couldn't create folder", { description: (err as Error).message });
    }
  }

  async function createFileFlow(creator: InstalledCreator) {
    if (space === "shared") {
      toast("Open a drive or space to create a file");
      return;
    }
    const input = window.prompt(`${creator.label} name`, creator.defaultName);
    if (!input?.trim()) return;
    const base = input.trim();
    const name = base.toLowerCase().endsWith(creator.extension) ? base : base + creator.extension;
    try {
      const file = await createFile(path, name, creator.template ?? "", creator.mime, space || undefined);
      reload();
      setPreviewFile(file); // open straight in the matching viewer/editor
    } catch (err) {
      toast("Couldn't create file", { description: (err as Error).message });
    }
  }

  async function upload(fileList: FileList | null) {
    const files = fileList ? Array.from(fileList) : [];
    if (files.length === 0) return;
    if (space === "shared") {
      toast("Open a drive or space to upload");
      return;
    }
    toast("Upload started", { description: `${files.length} file(s) → ${path || "drive"}` });
    try {
      await uploadFiles(path, files, space || undefined);
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
    if (id === "drive") {
      setSpace("");
      setPath("");
    }
    if (id.startsWith("plugin:")) setActivePlugin(id.replace("plugin:", ""));
  }

  function installPlugin(id: string) {
    if (installedIds.includes(id)) return;
    persistInstalled([...installedIds, id]);
    setActivePlugin(id);
    const name = registry.get(id)?.manifest.name ?? id;
    toast(`${name} installed`, { description: "Open it from the right rail or sidebar." });
  }

  function uninstallPlugin(id: string) {
    if (!installedIds.includes(id)) return;
    const name = registry.get(id)?.manifest.name ?? id;
    persistInstalled(installedIds.filter((x) => x !== id));
    if (active === `plugin:${id}`) navigate("drive"); // don't strand the user on a removed view
    toast(`${name} removed`);
  }

  async function deleteSelected() {
    const targets = files.filter((f) => selection.has(f.id) && f.kind !== "folder");
    const n = targets.length;
    setSelection(new Set());
    try {
      await Promise.all(targets.map((f) => deleteFile(f.id)));
      reload();
      toast(`${n} item${n === 1 ? "" : "s"} moved to Trash`);
    } catch (err) {
      toast("Delete failed", { description: (err as Error).message });
      reload();
    }
  }

  async function restoreFromTrash(f: FileItem) {
    setTrashFiles((fs) => fs.filter((x) => x.id !== f.id)); // optimistic
    try {
      await restoreFile(f.id);
      reload();
      toast("Restored", { description: f.name });
    } catch (err) {
      toast("Restore failed", { description: (err as Error).message });
      reload();
    }
  }

  async function purgeFromTrash(f: FileItem) {
    if (!window.confirm(`Permanently delete “${f.name}”? This can't be undone.`)) return;
    setTrashFiles((fs) => fs.filter((x) => x.id !== f.id)); // optimistic
    try {
      await purgeFile(f.id);
      reload();
      toast("Deleted forever", { description: f.name });
    } catch (err) {
      toast("Delete failed", { description: (err as Error).message });
      reload();
    }
  }

  async function emptyTrash() {
    const targets = [...trashFiles];
    if (targets.length === 0) return;
    if (!window.confirm(`Permanently delete all ${targets.length} item(s) in Trash? This can't be undone.`)) return;
    setTrashFiles([]); // optimistic
    try {
      await Promise.all(targets.map((f) => purgeFile(f.id)));
      reload();
      toast("Trash emptied");
    } catch (err) {
      toast("Couldn't empty Trash", { description: (err as Error).message });
      reload();
    }
  }

  // What "Share" targets for a row: a whole place (group space), a folder within
  // the active space, or a single file. Returns null for things that aren't one
  // shareable item (e.g. the cross-space "Shared with me" view).
  function shareTargetFor(f: FileItem): ShareTarget | null {
    if (f.id === "__shared") return null;
    if (f.id.startsWith("space:")) return { kind: "space", spaceId: f.id.slice(6) };
    if (f.kind === "folder") {
      const sid = space && space !== "shared" ? space : spaces.find((s) => s.kind === "personal")?.id;
      return sid ? { kind: "folder", spaceId: sid, path: f.path ?? "" } : null;
    }
    return { kind: "file", fileId: f.id };
  }

  async function onFileAction(action: string, f: FileItem) {
    if (action === "Delete") {
      if (f.kind === "folder") return;
      try {
        await deleteFile(f.id);
        reload();
        toast("Moved to Trash", { description: f.name });
      } catch (err) {
        toast("Delete failed", { description: (err as Error).message });
      }
    } else if (action === "Star") {
      const next = !f.starred;
      setFiles((fs) => fs.map((x) => (x.id === f.id ? { ...x, starred: next } : x))); // optimistic
      if (f.kind === "folder") return; // virtual folders have no record to persist to
      try {
        await setStarred(f.id, next);
      } catch (err) {
        setFiles((fs) => fs.map((x) => (x.id === f.id ? { ...x, starred: !next } : x))); // rollback
        toast("Couldn't update star", { description: (err as Error).message });
      }
    } else if (action === "Share") {
      // One Share dialog for files, folders, and group spaces: people/places +
      // links (web + WebDAV), each showing current shares with revoke.
      const target = shareTargetFor(f);
      if (!target) {
        toast("Can’t share this", { description: "“Shared with me” isn’t a single shareable item." });
        return;
      }
      setShareTarget({ target, label: f.name });
    } else if (action === "Download" && f.kind !== "folder") {
      window.open(contentUrl(f.id), "_blank");
    } else {
      toast(action, { description: f.name });
    }
  }

  async function moveItem(file: FileItem, folder: FileItem) {
    const dest = folder.path ?? "";
    if (file.kind === "folder" || file.path === dest) return;
    setFiles((fs) => fs.filter((x) => x.id !== file.id)); // optimistic: it leaves this folder
    setSelection(new Set());
    try {
      await moveFile(file.id, dest);
      reload();
      toast("Moved", { description: `${file.name} → ${folder.name}` });
    } catch (err) {
      toast("Move failed", { description: (err as Error).message });
      reload();
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

  const spaceName = space && space !== "shared" ? (spaces.find((s) => s.id === space)?.name ?? "Space") : null;
  // Where the "Connect a device" dialog offers to mount: the current place/folder
  // (so it can be mounted on its own), or null when we're not in a files view.
  const mountHere = (() => {
    if (active !== "drive" || space === "shared") return null; // real folder browsing only (not the starred/family filters)
    const segs = [spaceName, ...path.split("/").filter(Boolean)].filter((s): s is string => !!s);
    const url = `${window.location.origin}/dav${segs.length ? "/" + segs.map(encodeURIComponent).join("/") : ""}`;
    return { url, label: [spaceName ?? "My Drive", ...path.split("/").filter(Boolean)].join(" / ") };
  })();
  const driveCrumb =
    space === "shared"
      ? ["Shared with me"]
      : spaceName
        ? [spaceName, ...path.split("/").filter(Boolean)]
        : path
          ? ["My Drive", ...path.split("/").filter(Boolean)]
          : ["My Drive", "All files"];

  const breadcrumb =
    active === "home"
      ? ["Home"]
      : active === "starred"
        ? ["Starred"]
        : active === "trash"
          ? ["Trash"]
          : active === "build-plugin"
            ? ["Build a plugin"]
            : active === "settings"
              ? ["Settings"]
              : active.startsWith("plugin:")
              ? [installed.find((p) => `plugin:${p.id}` === active)?.name ?? "Plugin"]
              : driveCrumb;

  const railAvailable = active !== "home" && installed.some((p) => p.contributes?.railPanel);
  // A docked preview claims the right side, so the plugin rail steps aside while
  // it's open (the full-screen preview covers everything, rail included).
  const previewDocked = !!previewFile && previewMode === "split";
  const showRail = tweaks.showRail && railAvailable && !previewDocked;

  return (
    <PluginDataProvider githubInstalled={activeIds.includes("github")}>
    <div className="flex h-screen flex-col">
      <OfflineBanner />
      <DemoBanner auth={auth} onSignIn={signIn} />
      <InviteBanner auth={auth} onAccepted={reload} />
      <div
      className={cn(
        "app-grid min-h-0 flex-1",
        tweaks.sidebarCollapsed && "collapsed-sb",
        !showRail && "no-rail",
        previewDocked && "preview-split",
        tweaks.density !== "default" && `density-${tweaks.density}`,
        tweaks.radius !== "default" && `radius-${tweaks.radius}`,
      )}
      onDragOver={(e) => {
        // Only react to external file drags; internal file→folder moves carry a custom type.
        if (!e.dataTransfer.types.includes("Files")) return;
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
        spaces={spaces}
        currentSpace={active === "drive" ? space : ""}
        onOpenSpace={openSpace}
        onCreateSpace={createSpaceFlow}
        onRenameSpace={renameSpaceFlow}
        onToggleMount={togglePin}
        onNewFolder={createFolderFlow}
        onNewFile={createFileFlow}
        onUpload={() => uploadInputRef.current?.click()}
        onConnectDevice={() => setConnectOpen(true)}
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
          railAvailable={railAvailable}
          railOpen={tweaks.showRail}
          onToggleRail={() => setTweak("showRail", !tweaks.showRail)}
          auth={auth}
          onSignIn={signIn}
          onSignOut={signOut}
        />

        <main className="relative flex-1 overflow-auto">
          <div className="mx-auto max-w-[1280px] px-8 pb-8 pt-[22px]">
            {active === "home" ? (
              <HomeView
                installed={installed}
                files={files}
                spaces={spaces}
                overview={overview}
                sharedCount={sharedCount}
                userName={auth.user?.name ?? auth.user?.email}
                onOpenPlugin={(id) => navigate(`plugin:${id}`)}
                onOpenFile={setPreviewFile}
                onOpenSpace={openSpace}
              />
            ) : active === "trash" ? (
              <>
                <div className="mb-4 flex flex-wrap items-center gap-3">
                  <div className="min-w-0">
                    <h1 className="text-[22px] font-semibold tracking-tight">Trash</h1>
                    <div className="mt-0.5 whitespace-nowrap font-mono text-[13px] text-muted-foreground">
                      {trashFiles.length} item{trashFiles.length === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="flex-1" />
                  {trashFiles.length > 0 && (
                    <Button variant="outline" size="sm" className="gap-1.5" onClick={emptyTrash}>
                      <Icon name="trash" size={14} /> Empty Trash
                    </Button>
                  )}
                </div>
                <TrashView files={trashFiles} onRestore={restoreFromTrash} onPurge={purgeFromTrash} onPreview={setPreviewFile} />
              </>
            ) : active === "build-plugin" ? (
              <BuildPluginView />
            ) : active === "settings" ? (
              <SettingsView />
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
                      {spaceName && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            onClick={() =>
                              setMembersSpace({
                                id: space,
                                name: spaceName,
                                role: spaces.find((s) => s.id === space)?.role ?? "viewer",
                              })
                            }
                          >
                            <Icon name="users" size={14} /> Members
                          </Button>
                          {(() => {
                            const pinned = spaces.find((s) => s.id === space)?.mounted ?? true;
                            return (
                              <Button
                                variant={pinned ? "secondary" : "outline"}
                                size="sm"
                                className="gap-1.5"
                                onClick={() => void togglePin(space, !pinned)}
                              >
                                <Icon name="my-drive" size={14} /> {pinned ? "In My Drive" : "Pin to My Drive"}
                              </Button>
                            );
                          })()}
                        </>
                      )}
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
                    onMove={moveItem}
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

      <PluginStore
        open={storeOpen}
        onOpenChange={setStoreOpen}
        installedIds={installedIds}
        onInstall={installPlugin}
        onUninstall={uninstallPlugin}
        onConfigure={(id) =>
          setSettingsPlugin({ id, name: PLUGIN_CATALOG.find((p) => p.id === id)?.label ?? id })
        }
        onBuildWithAI={() => {
          setStoreOpen(false);
          navigate("build-plugin");
        }}
      />

      {settingsPlugin && (
        <PluginSettingsDialog
          pluginId={settingsPlugin.id}
          pluginName={settingsPlugin.name}
          open={!!settingsPlugin}
          onOpenChange={(o) => !o && setSettingsPlugin(null)}
          onPlacesChanged={refreshActive}
        />
      )}

      <FilePreview
        file={previewFile}
        mode={previewMode}
        onToggleMode={togglePreviewMode}
        onClose={() => setPreviewFile(null)}
        onSaved={reload}
        space={space === "shared" ? undefined : space || undefined}
      />

      {shareTarget && (
        <ShareDialog
          target={shareTarget.target}
          label={shareTarget.label}
          open={!!shareTarget}
          onOpenChange={(o) => !o && setShareTarget(null)}
        />
      )}

      {membersSpace && (
        <SpaceMembersDialog
          spaceId={membersSpace.id}
          spaceName={membersSpace.name}
          role={membersSpace.role}
          open={!!membersSpace}
          onOpenChange={(o) => !o && setMembersSpace(null)}
          onPluginsChanged={refreshActive}
        />
      )}

      <ConnectDeviceDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        currentUrl={mountHere?.url}
        currentLabel={mountHere?.label}
      />

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
    </PluginDataProvider>
  );
}

function EmptyState() {
  return (
    <div className="grid place-items-center py-24 text-center">
      <div className="grid size-16 place-items-center rounded-2xl bg-muted text-muted-foreground">
        <Icon name="trash" size={28} strokeWidth={1.25} />
      </div>
      <div className="mt-4 text-[16px] font-semibold">Trash is empty</div>
      <div className="mt-1 max-w-sm text-sm text-muted-foreground">
        Anything you delete shows up here first, so you can restore it before it's gone for good.
      </div>
    </div>
  );
}

function TrashView({
  files,
  onRestore,
  onPurge,
  onPreview,
}: {
  files: FileItem[];
  onRestore: (f: FileItem) => void;
  onPurge: (f: FileItem) => void;
  onPreview: (f: FileItem) => void;
}) {
  if (files.length === 0) return <EmptyState />;
  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full border-collapse text-[14px]">
        <thead>
          <tr className="border-b bg-muted/40 text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2.5 text-left">Name</th>
            <th className="w-[124px] px-3 py-2.5 text-left">Deleted</th>
            <th className="w-[96px] px-3 py-2.5 text-right">Size</th>
            <th className="w-[230px]" />
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr
              key={f.id}
              onDoubleClick={() => onPreview(f)}
              className="group cursor-default border-t transition-colors hover:bg-muted/50"
              style={{ height: "var(--row-h)" }}
            >
              <td className="px-3">
                <div className="flex items-center gap-3">
                  <FileIcon kind={f.kind} />
                  <span className="truncate font-medium">{f.name}</span>
                </div>
              </td>
              <td className="px-3 font-mono text-[12.5px] text-muted-foreground">{f.modified}</td>
              <td className="px-3 text-right font-mono text-[12.5px] text-muted-foreground">{f.size}</td>
              <td className="px-3">
                <div className="flex items-center justify-end gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => onRestore(f)}>
                    <Icon name="restore" size={13} /> Restore
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 text-destructive hover:text-destructive"
                    onClick={() => onPurge(f)}
                  >
                    <Icon name="trash" size={13} /> Delete forever
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PluginDetail({ id, installed }: { id: string; installed: { id: string; name: string; icon?: string; color?: string; contributes?: { store?: { tagline: string } } }[] }) {
  const manifest = installed.find((p) => p.id === id);
  const sandboxed = sandboxedSlot(id, "detailView");
  const DetailView = PLUGIN_UI[id]?.DetailView;
  const capabilities = usePluginCapabilities();
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
      {sandboxed ? (
        <PluginSlot plugin={id} slot="detailView" source={sandboxed.source} capabilities={capabilities} />
      ) : DetailView ? (
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
