import { useEffect, useRef, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { Icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { fetchMe, uploadFiles, loginUrl, type Me } from "@/lib/api";
import { CURRENT_USER, type FileItem } from "@/lib/mock-data";
import { DemoBanner } from "@/components/demo-banner";
import { InviteBanner } from "@/components/invite-banner";
import { OfflineBanner } from "@/components/offline-banner";
import { HomeScreen, DriveScreen, FamilyScreen, PluginsScreen } from "./screens";
import { NewActionSheet, FileDetailSheet } from "./sheets";

type View = "home" | "drive" | "family" | "plugins";

const TABS = [
  { id: "home", icon: "home", label: "Home" },
  { id: "drive", icon: "folder", label: "Files" },
  { id: "family", icon: "users", label: "Family" },
  { id: "plugins", icon: "package", label: "Plugins" },
] as const;

export function MobileApp() {
  const [view, setView] = useState<View>("home");
  const [sheet, setSheet] = useState<null | "new" | "file">(null);
  const [selFile, setSelFile] = useState<FileItem | null>(null);
  const [auth, setAuth] = useState<Me>({ user: null, authConfigured: false });
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchMe().then(setAuth);
  }, []);

  const userName =
    auth.user?.name ?? auth.user?.email?.split("@")[0] ?? CURRENT_USER.name.split(" ")[0]!;

  function openFile(f: FileItem) {
    setSelFile(f);
    setSheet("file");
  }

  const signIn = () => {
    window.location.href = loginUrl(window.location.pathname + window.location.search);
  };

  async function doUpload(list: FileList | null) {
    const files = list ? Array.from(list) : [];
    if (!files.length) return;
    toast("Upload started", { description: `${files.length} file(s) — destination My Drive` });
    try {
      await uploadFiles("", files);
      toast(`${files.length} file(s) uploaded`);
    } catch (e) {
      toast("Upload failed", { description: (e as Error).message });
    }
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background pt-[env(safe-area-inset-top)] text-foreground">
      <OfflineBanner />
      <DemoBanner auth={auth} onSignIn={signIn} />
      <InviteBanner auth={auth} onAccepted={() => window.location.reload()} />
      <main className="min-h-0 flex-1 overflow-y-auto">
        {view === "home" && <HomeScreen userName={userName} onOpenFile={openFile} onNav={(v) => setView(v as View)} />}
        {view === "drive" && <DriveScreen onOpenFile={openFile} />}
        {view === "family" && <FamilyScreen onOpenFile={openFile} />}
        {view === "plugins" && <PluginsScreen />}
        <div className="h-24" />
      </main>

      {/* FAB */}
      {sheet !== "file" && (
        <button
          onClick={() => setSheet("new")}
          className="fixed bottom-[104px] right-[18px] z-30 grid size-14 place-items-center rounded-[18px] bg-primary text-primary-foreground transition-transform active:scale-95"
          style={{ boxShadow: "0 8px 22px hsl(145 33% 36% / 0.32), 0 2px 6px hsl(145 33% 36% / 0.18)" }}
        >
          <Icon name="plus" size={26} strokeWidth={2.2} />
        </button>
      )}

      {/* Bottom tab bar */}
      <nav className="shrink-0 border-t bg-background/80 backdrop-blur-md">
        <div className="grid grid-cols-4" style={{ height: 56 }}>
          {TABS.map((t) => {
            const active = view === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setView(t.id)}
                className="flex flex-col items-center justify-center gap-0.5"
              >
                <Icon
                  name={t.icon}
                  size={22}
                  strokeWidth={active ? 2 : 1.75}
                  className={active ? "text-primary" : "text-muted-foreground"}
                />
                <span
                  className={cn(
                    "text-[10.5px]",
                    active ? "font-semibold text-primary" : "font-medium text-muted-foreground",
                  )}
                >
                  {t.label}
                </span>
              </button>
            );
          })}
        </div>
        <div style={{ height: "max(env(safe-area-inset-bottom), 8px)" }} />
      </nav>

      <NewActionSheet
        open={sheet === "new"}
        onOpenChange={(o) => setSheet(o ? "new" : null)}
        onUpload={() => uploadRef.current?.click()}
      />
      <FileDetailSheet file={selFile} open={sheet === "file"} onOpenChange={(o) => setSheet(o ? "file" : null)} />

      <input
        ref={uploadRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void doUpload(e.target.files);
          e.target.value = "";
        }}
      />

      <Toaster position="top-center" />
    </div>
  );
}
