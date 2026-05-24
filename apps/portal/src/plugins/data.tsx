import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { getCalendar, getTasks, type CalendarEvent, type Task } from "@/lib/api";
import { SAMPLE_TASKS, sampleEvents } from "./sample-data";
import type { CapabilityMap } from "@/components/plugin-slot";

/**
 * Plugin data wiring. Tasks/calendar render *live* data once a source plugin
 * (GitHub) is installed and the server reports it connected; otherwise they show
 * project-flavored sample data. The host advertises whether GitHub is installed
 * via context; the hooks fetch and pick live-vs-sample.
 */

type Source = "github" | "sample";

const Ctx = createContext<{ githubInstalled: boolean; nonce: number; refresh: () => void }>({
  githubInstalled: false,
  nonce: 0,
  refresh: () => {},
});

export function PluginDataProvider({ githubInstalled, children }: { githubInstalled: boolean; children: ReactNode }) {
  const [nonce, setNonce] = useState(0);
  const refresh = () => setNonce((n) => n + 1);
  return <Ctx.Provider value={{ githubInstalled, nonce, refresh }}>{children}</Ctx.Provider>;
}

/** Bump after changing a source's settings so tasks/calendar refetch live data. */
export function usePluginDataRefresh(): () => void {
  return useContext(Ctx).refresh;
}

export function useTasks(): { tasks: Task[]; source: Source; loading: boolean } {
  const { githubInstalled, nonce } = useContext(Ctx);
  const [state, setState] = useState<{ tasks: Task[]; source: Source; loading: boolean }>({
    tasks: SAMPLE_TASKS,
    source: "sample",
    loading: githubInstalled,
  });

  useEffect(() => {
    if (!githubInstalled) {
      setState({ tasks: SAMPLE_TASKS, source: "sample", loading: false });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    getTasks()
      .then((r) => {
        if (!alive) return;
        // Connected → show live data as-is (even if empty); else sample.
        if (r.source) setState({ tasks: r.tasks, source: "github", loading: false });
        else setState({ tasks: SAMPLE_TASKS, source: "sample", loading: false });
      })
      .catch(() => alive && setState({ tasks: SAMPLE_TASKS, source: "sample", loading: false }));
    return () => {
      alive = false;
    };
  }, [githubInstalled, nonce]);

  return state;
}

/**
 * Calendar fetch + sample fallback, decoupled from React so it can run inside a
 * host capability handler (sandboxed plugins call this via `ctx.call`, not a hook).
 * Connected → live GitHub data as-is; otherwise project-flavored sample events.
 */
async function fetchCalendarEvents(githubInstalled: boolean): Promise<{ events: CalendarEvent[]; source: Source }> {
  if (!githubInstalled) return { events: sampleEvents(), source: "sample" };
  try {
    const r = await getCalendar();
    if (r.source) return { events: r.events, source: "github" };
  } catch {
    // fall through to sample
  }
  return { events: sampleEvents(), source: "sample" };
}

/**
 * The capability map handed to sandboxed UI-slot plugins ({@link PluginSlot}).
 * Each entry is a method the host fulfils with its own credentials — the plugin
 * can only call what's wired here. Keyed by `<domain>.<verb>`; `nonce` lets a
 * settings change re-resolve on the next call.
 */
export function usePluginCapabilities(): CapabilityMap {
  const { githubInstalled, nonce } = useContext(Ctx);
  void nonce; // referenced so the map is rebuilt after a refresh()
  return {
    "calendar.list": () => fetchCalendarEvents(githubInstalled),
  };
}
