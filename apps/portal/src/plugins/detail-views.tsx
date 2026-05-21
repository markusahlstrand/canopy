import { Plus } from "lucide-react";
import { PersonAvatar } from "@/components/person-avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { TONE_COLOR } from "@/lib/mock-data";

const DAYS = ["Sun May 3", "Mon May 4", "Tue May 5", "Wed May 6", "Thu May 7", "Fri May 8", "Sat May 9"];
const HOURS = ["8 AM", "9 AM", "10 AM", "11 AM", "12 PM", "1 PM", "2 PM", "3 PM", "4 PM", "5 PM", "6 PM", "7 PM"];
const EVENTS = [
  { day: 0, start: 1, len: 1, title: "Lily violin", tone: "info" },
  { day: 1, start: 3, len: 1, title: "Standup", tone: "primary" },
  { day: 2, start: 8, len: 2, title: "Family dinner", tone: "primary" },
  { day: 3, start: 5, len: 1, title: "Maya — recital", tone: "berry" },
  { day: 4, start: 0, len: 1, title: "Yoga", tone: "accent" },
  { day: 5, start: 1, len: 1, title: "Pediatrician", tone: "info" },
  { day: 6, start: 6, len: 2, title: "Soccer game", tone: "primary" },
];
const ROW_H = 44;

export function CalendarWeekView() {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="grid border-b" style={{ gridTemplateColumns: "60px repeat(7, 1fr)" }}>
        <div />
        {DAYS.map((d) => (
          <div key={d} className="border-l px-3 py-2.5 text-[12.5px] font-medium text-muted-foreground">
            {d}
          </div>
        ))}
      </div>
      <div className="grid" style={{ gridTemplateColumns: "60px repeat(7, 1fr)" }}>
        <div>
          {HOURS.map((h) => (
            <div
              key={h}
              className="border-t px-2 text-right font-mono text-[11px] text-muted-foreground"
              style={{ height: ROW_H, lineHeight: `${ROW_H}px` }}
            >
              {h}
            </div>
          ))}
        </div>
        {DAYS.map((d, di) => (
          <div key={d} className="relative border-l">
            {HOURS.map((_, hi) => (
              <div key={hi} className="border-t" style={{ height: ROW_H }} />
            ))}
            {EVENTS.filter((e) => e.day === di).map((e, i) => (
              <div
                key={i}
                className="absolute overflow-hidden rounded-md px-2 py-1 text-[11.5px] font-medium"
                style={{
                  top: e.start * ROW_H + 3,
                  left: 4,
                  right: 4,
                  height: e.len * ROW_H - 6,
                  background: `hsl(${TONE_COLOR[e.tone]} / 0.16)`,
                  borderLeft: `3px solid hsl(${TONE_COLOR[e.tone]})`,
                }}
              >
                {e.title}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

const COLUMNS = [
  {
    title: "Up next",
    color: "145 33% 36%",
    items: [
      { title: "Renew home insurance", due: "Today", who: "Maya", high: true },
      { title: "Schedule Lily's checkup", due: "Tomorrow", who: "Daniel" },
      { title: "Buy gift for Nora", due: "May 18", who: "Maya" },
      { title: "Pick up dry cleaning", due: "May 19", who: "Daniel" },
    ],
  },
  {
    title: "Later",
    color: "212 70% 48%",
    items: [
      { title: "Plan summer trip", due: "Jun", who: "Maya" },
      { title: "Service the car", due: "Jun 5", who: "Daniel" },
      { title: "Tax extension", due: "Jul", who: "Maya" },
    ],
  },
  {
    title: "Done this week",
    color: "220 9% 46%",
    items: [
      { title: "Sort tax documents", who: "Daniel", done: true },
      { title: "Order soccer cleats", who: "Maya", done: true },
      { title: "Sign permission slip", who: "Maya", done: true },
    ],
  },
] as const;

export function TasksKanban() {
  return (
    <div className="grid grid-cols-3 gap-3.5">
      {COLUMNS.map((col) => (
        <div key={col.title} className="flex flex-col gap-2 rounded-lg border bg-card p-3.5">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="size-2 rounded-full" style={{ background: `hsl(${col.color})` }} />
            <span className="text-[13.5px] font-semibold">{col.title}</span>
            <span className="font-mono text-xs text-muted-foreground">{col.items.length}</span>
          </div>
          {col.items.map((t, i) => (
            <div
              key={i}
              className="rounded-md border bg-muted/50 p-2.5"
              style={{ opacity: "done" in t && t.done ? 0.6 : 1 }}
            >
              <div className="flex items-center gap-2">
                <Checkbox defaultChecked={"done" in t && t.done} />
                <span className={`flex-1 text-[13.5px] font-medium ${"done" in t && t.done ? "line-through" : ""}`}>
                  {t.title}
                </span>
                <PersonAvatar name={t.who} size="xs" />
              </div>
              {"due" in t && t.due && !("done" in t && t.done) && (
                <div className="ml-6 mt-1.5 flex items-center gap-1.5">
                  <span
                    className={`font-mono text-[11.5px] ${"high" in t && t.high ? "font-semibold text-destructive" : "text-muted-foreground"}`}
                  >
                    {t.due}
                  </span>
                  {"high" in t && t.high && (
                    <Badge variant="outline" className="border-destructive/40 px-1 py-0 text-[10px] text-destructive">
                      High
                    </Badge>
                  )}
                </div>
              )}
            </div>
          ))}
          <button className="mt-1 flex items-center gap-1.5 rounded-md px-1 py-1 text-[13px] text-muted-foreground hover:bg-accent/60">
            <Plus size={13} /> Add task
          </button>
        </div>
      ))}
    </div>
  );
}
