import { ExternalLink } from "lucide-react";
import { PersonAvatar } from "@/components/person-avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { TONE_COLOR } from "@/lib/mock-data";
import type { CalendarEvent, Task, TaskStatus } from "@/lib/api";
import { useCalendar, useTasks } from "./data";

const STATUS_COLUMNS: { status: TaskStatus; title: string; color: string }[] = [
  { status: "todo", title: "To do", color: "212 70% 48%" },
  { status: "in_progress", title: "In progress", color: "145 33% 36%" },
  { status: "blocked", title: "Blocked", color: "0 72% 51%" },
  { status: "done", title: "Done", color: "220 9% 46%" },
];

/** A small pill telling the user whether they're seeing live or sample data. */
function SourcePill({ source }: { source: "github" | "sample" }) {
  if (source === "github") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-[11.5px] font-medium text-primary">
        <span className="size-1.5 rounded-full bg-primary" /> Live from GitHub
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11.5px] text-muted-foreground">
      Sample data · install the GitHub plugin for live data
    </span>
  );
}

function TaskCard({ t }: { t: Task }) {
  const done = t.status === "done";
  const Title = t.url ? "a" : "span";
  return (
    <div className="rounded-md border bg-muted/50 p-2.5" style={{ opacity: done ? 0.6 : 1 }}>
      <div className="flex items-center gap-2">
        <Checkbox defaultChecked={done} />
        <Title
          {...(t.url ? { href: t.url, target: "_blank", rel: "noreferrer" } : {})}
          className={`flex-1 truncate text-[13.5px] font-medium ${done ? "line-through" : ""} ${t.url ? "hover:underline" : ""}`}
        >
          {t.title}
        </Title>
        {t.assignee && <PersonAvatar name={t.assignee} size="xs" />}
      </div>
      {(t.due || t.priority === "high" || (t.labels && t.labels.length > 0)) && !done && (
        <div className="ml-6 mt-1.5 flex flex-wrap items-center gap-1.5">
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
          {t.labels?.slice(0, 2).map((l) => (
            <Badge key={l} variant="outline" className="px-1 py-0 text-[10px] text-muted-foreground">
              {l}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

export function TasksKanban() {
  const { tasks, source, loading } = useTasks();
  const byStatus = (s: TaskStatus) => tasks.filter((t) => t.status === s);
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center gap-2">
        <SourcePill source={source} />
        {loading && <span className="text-[12px] text-muted-foreground">Loading…</span>}
      </div>
      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        {STATUS_COLUMNS.map((col) => {
          const items = byStatus(col.status);
          return (
            <div key={col.status} className="flex flex-col gap-2 rounded-lg border bg-card p-3.5">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="size-2 rounded-full" style={{ background: `hsl(${col.color})` }} />
                <span className="text-[13.5px] font-semibold">{col.title}</span>
                <span className="font-mono text-xs text-muted-foreground">{items.length}</span>
              </div>
              {items.map((t) => (
                <TaskCard key={t.id} t={t} />
              ))}
              {items.length === 0 && <div className="rounded-md border border-dashed p-3 text-center text-[12px] text-muted-foreground">Nothing here</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const KIND_LABEL: Record<NonNullable<CalendarEvent["kind"]>, string> = {
  milestone: "Milestone",
  release: "Release",
  issue: "Issue",
  event: "Event",
};

/** Group events by calendar day, preserving chronological order. */
function groupByDay(events: CalendarEvent[]): { day: string; items: CalendarEvent[] }[] {
  const sorted = [...events].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const groups: { day: string; items: CalendarEvent[] }[] = [];
  for (const e of sorted) {
    const day = new Date(e.start).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(e);
    else groups.push({ day, items: [e] });
  }
  return groups;
}

export function CalendarView() {
  const { events, source, loading } = useCalendar();
  const groups = groupByDay(events);
  return (
    <div className="flex max-w-2xl flex-col gap-3.5">
      <div className="flex items-center gap-2">
        <SourcePill source={source} />
        {loading && <span className="text-[12px] text-muted-foreground">Loading…</span>}
      </div>
      {groups.length === 0 && !loading && (
        <div className="rounded-lg border border-dashed p-8 text-center text-[13px] text-muted-foreground">
          No upcoming milestones or releases.
        </div>
      )}
      <div className="flex flex-col gap-4">
        {groups.map((g) => (
          <div key={g.day} className="flex gap-4">
            <div className="w-28 shrink-0 pt-1 text-[12.5px] font-medium text-muted-foreground">{g.day}</div>
            <div className="flex flex-1 flex-col gap-2">
              {g.items.map((e) => {
                const tone = e.tone && TONE_COLOR[e.tone] ? TONE_COLOR[e.tone] : TONE_COLOR.primary;
                const Title = e.url ? "a" : "span";
                return (
                  <div key={e.id} className="flex items-center gap-2.5 rounded-lg border bg-card p-2.5">
                    <span className="h-8 w-1 shrink-0 rounded-full" style={{ background: `hsl(${tone})` }} />
                    <Title
                      {...(e.url ? { href: e.url, target: "_blank", rel: "noreferrer" } : {})}
                      className={`flex-1 truncate text-[13.5px] font-medium ${e.url ? "hover:underline" : ""}`}
                    >
                      {e.title}
                    </Title>
                    {e.kind && (
                      <Badge variant="outline" className="px-1.5 py-0 text-[10.5px] text-muted-foreground">
                        {KIND_LABEL[e.kind]}
                      </Badge>
                    )}
                    {e.url && <ExternalLink size={13} className="text-muted-foreground" />}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
