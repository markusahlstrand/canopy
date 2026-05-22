import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { getCalendar, getTasks, type CalendarEvent, type Task } from "@/lib/api";
import { SAMPLE_TASKS, sampleEvents } from "./sample-data";

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

export function useCalendar(): { events: CalendarEvent[]; source: Source; loading: boolean } {
  const { githubInstalled, nonce } = useContext(Ctx);
  const [state, setState] = useState<{ events: CalendarEvent[]; source: Source; loading: boolean }>({
    events: sampleEvents(),
    source: "sample",
    loading: githubInstalled,
  });

  useEffect(() => {
    if (!githubInstalled) {
      setState({ events: sampleEvents(), source: "sample", loading: false });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    getCalendar()
      .then((r) => {
        if (!alive) return;
        if (r.source) setState({ events: r.events, source: "github", loading: false });
        else setState({ events: sampleEvents(), source: "sample", loading: false });
      })
      .catch(() => alive && setState({ events: sampleEvents(), source: "sample", loading: false }));
    return () => {
      alive = false;
    };
  }, [githubInstalled, nonce]);

  return state;
}
