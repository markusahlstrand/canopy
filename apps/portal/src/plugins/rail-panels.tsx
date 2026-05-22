import { useState } from "react";
import { PersonAvatar } from "@/components/person-avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { TONE_COLOR } from "@/lib/mock-data";
import { useCalendar, useTasks } from "./data";

export function CalendarPanel() {
  const { events, loading } = useCalendar();
  const [now] = useState(() => Date.now()); // stable per mount; pure during render
  const upcoming = events
    .filter((e) => Date.parse(e.start) >= now - 864e5)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(0, 6);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <span className="font-semibold">Up next</span>
        {loading && <span className="text-[11.5px] text-muted-foreground">Loading…</span>}
      </div>
      <div className="flex flex-col gap-1.5">
        {upcoming.map((e) => {
          const tone = e.tone && TONE_COLOR[e.tone] ? TONE_COLOR[e.tone] : TONE_COLOR.primary;
          const Title = e.url ? "a" : "div";
          return (
            <div key={e.id} className="flex gap-2.5 rounded-md p-1.5 hover:bg-accent/60">
              <span className="w-0.5 shrink-0 rounded-full" style={{ background: `hsl(${tone})` }} />
              <div className="min-w-0 flex-1">
                <Title
                  {...(e.url ? { href: e.url, target: "_blank", rel: "noreferrer" } : {})}
                  className={`block truncate text-[13px] font-medium ${e.url ? "hover:underline" : ""}`}
                >
                  {e.title}
                </Title>
                <div className="font-mono text-[11.5px] text-muted-foreground">
                  {new Date(e.start).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                </div>
              </div>
            </div>
          );
        })}
        {upcoming.length === 0 && !loading && (
          <p className="text-[12.5px] text-muted-foreground">Nothing coming up.</p>
        )}
      </div>
    </div>
  );
}

export function TasksPanel() {
  const { tasks, loading } = useTasks();
  const open = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <span className="font-semibold">Tasks</span>
        <span className="font-mono text-xs text-muted-foreground">
          {loading ? "…" : `${open.length} open · ${done.length} done`}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        {open.slice(0, 8).map((t) => (
          <div key={t.id} className="flex items-start gap-2.5 rounded-md p-1.5 hover:bg-accent/60">
            <Checkbox className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-medium">{t.title}</div>
              {(t.due || t.priority === "high") && (
                <div className="mt-1 flex items-center gap-1.5">
                  {t.due && (
                    <span className="font-mono text-[11.5px] text-muted-foreground">
                      {new Date(t.due).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </span>
                  )}
                  {t.priority === "high" && (
                    <Badge variant="outline" className="border-destructive/40 px-1 py-0 text-[10px] text-destructive">
                      High
                    </Badge>
                  )}
                </div>
              )}
            </div>
            {t.assignee && <PersonAvatar name={t.assignee} size="xs" />}
          </div>
        ))}
        {open.length === 0 && !loading && <p className="text-[12.5px] text-muted-foreground">No open tasks.</p>}
      </div>

      {done.length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Done</div>
          <div className="flex flex-col gap-1 opacity-70">
            {done.slice(0, 4).map((t) => (
              <div key={t.id} className="flex items-center gap-2.5 rounded-md p-1.5">
                <Checkbox defaultChecked className="mt-0" />
                <span className="flex-1 truncate text-[13.5px] line-through">{t.title}</span>
                {t.assignee && <PersonAvatar name={t.assignee} size="xs" />}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
