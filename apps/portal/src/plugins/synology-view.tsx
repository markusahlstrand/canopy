import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { PluginSettingsDialog } from "@/components/plugin-settings-dialog";
import { listSpaces } from "@/lib/api";

/**
 * The Synology integration's detail view: whether a NAS is connected (a
 * `connector:synology` space resolves once host + credentials are saved) and a
 * Settings button to enter the address / QuickConnect ID and account.
 *
 * The connected space is browsed live over FileStation. It is read-only for now;
 * read-write (upload / new folder / delete straight onto the NAS) is the next
 * milestone — see the project notes.
 */
export function SynologyView() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [state, setState] = useState<{ connected: boolean; name: string | null; loading: boolean }>({
    connected: false,
    name: null,
    loading: true,
  });

  const load = useCallback(async () => {
    const spaces = await listSpaces();
    const space = spaces.find((s) => s.id === "connector:synology");
    setState({ connected: !!space, name: space?.name ?? null, loading: false });
  }, []);

  useEffect(() => {
    let alive = true;
    void load().catch(() => alive && setState((s) => ({ ...s, loading: false })));
    return () => {
      alive = false;
    };
  }, [load]);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-5 py-2">
      <div className="flex items-center gap-3">
        <div className="grid size-11 place-items-center rounded-xl text-background" style={{ background: "hsl(190 65% 42%)" }}>
          <Icon name="hard-drive" size={22} />
        </div>
        <div className="flex-1">
          <div className="text-[16px] font-semibold">Synology</div>
          <div className="text-[13px] text-muted-foreground">Browse a DiskStation as a space, over FileStation.</div>
        </div>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setSettingsOpen(true)}>
          <Icon name="settings" size={15} /> Settings
        </Button>
      </div>

      {state.loading ? (
        <div className="text-[13px] text-muted-foreground">Checking connection…</div>
      ) : state.connected ? (
        <div className="flex items-center gap-2 rounded-lg border bg-card px-3.5 py-2.5 text-[13px]">
          <Icon name="hard-drive" size={15} className="text-muted-foreground" />
          <span className="font-mono">{state.name}</span>
          <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[11.5px] text-muted-foreground">read-only</span>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed p-5 text-[13px] text-muted-foreground">
          No NAS connected yet. Open <span className="font-medium text-foreground">Settings</span> to add your DiskStation — a
          direct address (e.g. <span className="font-mono">https://nas.example:5001</span>) or a QuickConnect ID, plus a DSM
          account.
        </div>
      )}

      <div className="rounded-lg bg-muted/60 p-3 text-[12.5px] leading-relaxed text-muted-foreground">
        Once connected, a <span className="font-medium text-foreground">Synology</span> space appears in the sidebar and lists
        files live from the NAS. From a cloud deployment, only a QuickConnect relay or a public HTTPS address is reachable — a
        LAN-only address works from a self-hosted server on the same network.
      </div>

      <PluginSettingsDialog
        pluginId="synology"
        pluginName="Synology"
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onSaved={() => void load()}
      />
    </div>
  );
}
