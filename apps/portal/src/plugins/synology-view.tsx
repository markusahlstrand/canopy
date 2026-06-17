import { useCallback, useEffect, useState } from "react";
import { Icon, Button } from "@canopy/ui";
import { PluginSettingsDialog, usePluginHost } from "@canopy/plugin-sdk";

interface ConnState {
  /** Config is saved, so the space exists — independent of whether the NAS answers. */
  connected: boolean;
  name: string | null;
  loading: boolean;
  /** The live failure from probing the NAS, or null when it answered (or nothing's saved). */
  error: string | null;
}

/**
 * The Synology integration's detail view: whether a NAS is connected (a
 * `connector:synology` space resolves once host + credentials are saved) and a
 * Settings button to enter the address / QuickConnect ID and account.
 *
 * A saved config makes the space *appear*, but says nothing about whether the box
 * is reachable — so we also probe it (`testConnector`) and surface the real
 * failure inline (bad credentials, unreachable host, a QuickConnect that won't
 * resolve) rather than showing a misleading "connected".
 *
 * The connected space is browsed live over FileStation. It is read-only for now;
 * read-write (upload / new folder / delete straight onto the NAS) is the next
 * milestone — see the project notes.
 */
export function SynologyView() {
  const host = usePluginHost();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [state, setState] = useState<ConnState>({ connected: false, name: null, loading: true, error: null });
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState(false);

  const onSync = useCallback(async () => {
    setSyncing(true);
    setSynced(false);
    try {
      const res = await host.syncConnector("synology");
      if (res.ok) {
        setSynced(true);
        setTimeout(() => setSynced(false), 4000);
      }
    } catch {
      // Surface the failure on the next probe; here we just don't get stuck "Syncing…".
    } finally {
      setSyncing(false);
    }
  }, [host]);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const spaces = await host.listSpaces();
      const space = spaces.find((s) => s.id === "connector:synology");
      if (!space) {
        setState({ connected: false, name: null, loading: false, error: null });
        return;
      }
      // Config is saved → probe the NAS so a failure shows up here instead of only
      // when the user clicks into the space and gets an opaque empty folder.
      const result = await host.testConnector("synology");
      setState({ connected: true, name: space.name ?? null, loading: false, error: result.ok ? null : (result.error ?? "Connection failed") });
    } catch (err) {
      setState({ connected: false, name: null, loading: false, error: (err as Error).message });
    }
  }, [host]);

  useEffect(() => {
    void load();
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
      ) : state.connected && state.error ? (
        <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3.5 py-3 text-[13px]">
          <div className="flex items-center gap-2">
            <Icon name="alert-triangle" size={15} className="text-destructive" />
            <span className="font-mono">{state.name}</span>
            <span className="ml-auto rounded-full bg-destructive/15 px-2 py-0.5 text-[11.5px] font-medium text-destructive">
              can't connect
            </span>
          </div>
          <p className="break-words font-mono text-[12px] leading-relaxed text-destructive">{state.error}</p>
          <div className="flex items-center gap-2 pt-0.5">
            <Button size="sm" variant="outline" className="h-7 gap-1.5" onClick={() => void load()}>
              <Icon name="refresh" size={13} /> Retry
            </Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setSettingsOpen(true)}>
              Edit settings
            </Button>
          </div>
        </div>
      ) : state.connected ? (
        <div className="flex items-center gap-2 rounded-lg border bg-card px-3.5 py-2.5 text-[13px]">
          <Icon name="hard-drive" size={15} className="text-muted-foreground" />
          <span className="font-mono">{state.name}</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11.5px] text-muted-foreground">read-only</span>
          <Button size="sm" variant="outline" className="ml-auto h-7 gap-1.5" disabled={syncing} onClick={() => void onSync()}>
            <Icon name="refresh" size={13} className={syncing ? "animate-spin" : undefined} />
            {syncing ? "Syncing…" : synced ? "Sync started" : "Sync now"}
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed p-5 text-[13px] text-muted-foreground">
          No NAS connected yet. Open <span className="font-medium text-foreground">Settings</span> to add your DiskStation — a
          direct address (e.g. <span className="font-mono">https://nas.example:5001</span>), a Tailscale host (e.g.{" "}
          <span className="font-mono">nas.tailnet.ts.net</span>), or a QuickConnect ID, plus a DSM account.
        </div>
      )}

      <div className="rounded-lg bg-muted/60 p-3 text-[12.5px] leading-relaxed text-muted-foreground">
        Once connected, a <span className="font-medium text-foreground">Synology</span> space appears in the sidebar. Browsing
        indexes the NAS as you go, so its files turn up in search and are reachable by connected assistants; out-of-band changes
        converge on the next sync. From a cloud deployment, only a QuickConnect relay or a public HTTPS address is reachable. A
        self-hosted server reaches a LAN address directly, or a Tailscale host (<span className="font-mono">100.x</span> or a
        MagicDNS name) when that server is on the same tailnet — the NAS can join via the Synology Tailscale package or a
        subnet router.
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
