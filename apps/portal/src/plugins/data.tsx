import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  createCalendar,
  createEvent,
  createTask,
  getCalendar,
  getTasks,
  listCalendars,
  type Calendar,
  type CalendarEvent,
  type CreateEventInput,
  type CreateTaskInput,
  type Task,
} from "@/lib/api";
import { SAMPLE_TASKS, sampleEvents } from "./sample-data";
import type { CapabilityMap } from "@/components/plugin-slot";

/**
 * Plugin data wiring. Tasks/calendar render *live* data once a source plugin
 * (GitHub) is installed and the server reports it connected; otherwise they show
 * project-flavored sample data. The host advertises whether GitHub is installed
 * via context; the hooks fetch and pick live-vs-sample.
 */

type Source = "github" | "sample" | "owned" | "owned+github";

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
  const { nonce } = useContext(Ctx);
  const [state, setState] = useState<{ tasks: Task[]; source: Source; loading: boolean }>({
    tasks: SAMPLE_TASKS,
    source: "sample",
    loading: true,
  });

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    // Always ask the server: it aggregates owned tasks (when signed in) with any
    // connected source (GitHub). Only when nothing contributed do we show sample.
    getTasks()
      .then((r) => {
        if (!alive) return;
        if (r.source) setState({ tasks: r.tasks, source: r.source as Source, loading: false });
        else setState({ tasks: SAMPLE_TASKS, source: "sample", loading: false });
      })
      .catch(() => alive && setState({ tasks: SAMPLE_TASKS, source: "sample", loading: false }));
    return () => {
      alive = false;
    };
  }, [nonce]);

  return state;
}

/**
 * Calendar fetch + sample fallback, decoupled from React so it can run inside a
 * host capability handler (sandboxed plugins call this via `ctx.call`, not a hook).
 * The server aggregates the caller's owned calendars/events (#34) with any
 * connected source (GitHub); only when nothing contributed do we show sample data.
 */
async function fetchCalendarEvents(): Promise<{ events: CalendarEvent[]; source: Source; calendars: Calendar[] }> {
  try {
    const r = await getCalendar();
    if (r.source || r.calendars.length) return { events: r.events, source: (r.source as Source) ?? "owned", calendars: r.calendars };
  } catch {
    // fall through to sample
  }
  return { events: sampleEvents(), source: "sample", calendars: [] };
}

/**
 * The capability map handed to sandboxed UI-slot plugins ({@link PluginSlot}).
 * Each entry is a method the host fulfils with its own credentials — the plugin
 * can only call what's wired here. Keyed by `<domain>.<verb>`; `nonce` lets a
 * settings change re-resolve on the next call.
 *
 * The `calendar.*` write verbs back the owned-calendar surface (#34): the plugin
 * proposes a calendar/event/task and the host performs the credentialed write,
 * scoped by the drive's folder-grant ACL server-side.
 */
export function usePluginCapabilities(): CapabilityMap {
  const { nonce } = useContext(Ctx);
  void nonce; // referenced so the map is rebuilt after a refresh()
  return {
    "calendar.list": () => fetchCalendarEvents(),
    "calendar.calendars": () => listCalendars(),
    "calendar.createCalendar": (p) =>
      createCalendar(p as { name: string; space?: string; path?: string; color?: string | null }),
    "calendar.createEvent": (p) => createEvent(p as CreateEventInput),
    "calendar.createTask": (p) => createTask(p as CreateTaskInput),
  };
}
