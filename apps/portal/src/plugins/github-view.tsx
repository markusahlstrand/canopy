import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { PluginSettingsDialog } from "@/components/plugin-settings-dialog";
import { getCalendar, getIntegrations, getTasks } from "@/lib/api";
import { usePluginDataRefresh } from "./data";

/**
 * The GitHub integration's detail view: connection status, which repo is feeding
 * data, synced counts, and a Settings button to connect a different repo / token.
 */
export function GithubView() {
  const refreshData = usePluginDataRefresh();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [state, setState] = useState<{
    connected: boolean;
    repo: string | null;
    usingDefault: boolean;
    tasks: number;
    events: number;
    loading: boolean;
  }>({ connected: false, repo: null, usingDefault: false, tasks: 0, events: 0, loading: true });

  const load = useCallback(async () => {
    const integ = await getIntegrations();
    if (!integ.sourceId) {
      setState({ connected: false, repo: null, usingDefault: false, tasks: 0, events: 0, loading: false });
      return;
    }
    const [t, c] = await Promise.all([getTasks(), getCalendar()]);
    setState({
      connected: true,
      repo: integ.repo,
      usingDefault: integ.usingDefault,
      tasks: t.tasks.length,
      events: c.events.length,
      loading: false,
    });
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
        <div className="grid size-11 place-items-center rounded-xl bg-foreground text-background">
          <Icon name="github" size={22} />
        </div>
        <div className="flex-1">
          <div className="text-[16px] font-semibold">GitHub</div>
          <div className="text-[13px] text-muted-foreground">Issues become tasks; milestones &amp; releases become calendar events.</div>
        </div>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setSettingsOpen(true)}>
          <Icon name="settings" size={15} /> Settings
        </Button>
      </div>

      {state.loading ? (
        <div className="text-[13px] text-muted-foreground">Checking connection…</div>
      ) : state.connected ? (
        <>
          <div className="flex items-center gap-2 rounded-lg border bg-card px-3.5 py-2.5 text-[13px]">
            <Icon name="github" size={15} className="text-muted-foreground" />
            <span className="font-mono">{state.repo}</span>
            {state.usingDefault && (
              <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[11.5px] text-muted-foreground">demo default</span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border bg-card p-4">
              <div className="text-[12px] uppercase tracking-wide text-muted-foreground">Tasks</div>
              <div className="mt-1 font-mono text-2xl font-semibold">{state.tasks}</div>
              <div className="text-[12.5px] text-muted-foreground">issues synced</div>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <div className="text-[12px] uppercase tracking-wide text-muted-foreground">Calendar</div>
              <div className="mt-1 font-mono text-2xl font-semibold">{state.events}</div>
              <div className="text-[12.5px] text-muted-foreground">milestones &amp; releases</div>
            </div>
          </div>
          {state.usingDefault && (
            <p className="text-[12.5px] text-muted-foreground">
              You're seeing the demo repository. Open <span className="font-medium text-foreground">Settings</span> to connect your own.
            </p>
          )}
        </>
      ) : (
        <div className="rounded-lg border border-dashed p-5 text-[13px] text-muted-foreground">
          No repository connected yet. Open <span className="font-medium text-foreground">Settings</span> to add one (a public repo
          needs no token; private repos need a personal access token).
        </div>
      )}

      <div className="rounded-lg bg-muted/60 p-3 text-[12.5px] leading-relaxed text-muted-foreground">
        Open <span className="font-medium text-foreground">Tasks</span> or <span className="font-medium text-foreground">Calendar</span> from the
        sidebar to see the synced data. While disconnected, those plugins show sample data.
      </div>

      <PluginSettingsDialog
        pluginId="github"
        pluginName="GitHub"
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onSaved={() => {
          void load();
          refreshData();
        }}
      />
    </div>
  );
}
