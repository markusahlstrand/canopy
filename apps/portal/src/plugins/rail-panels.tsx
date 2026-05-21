import { ChevronLeft, ChevronRight } from "lucide-react";
import { PersonAvatar } from "@/components/person-avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { TONE_COLOR } from "@/lib/mock-data";

const UP_NEXT = [
  { day: 14, title: "Lily — violin", sub: "Today · 4:00 PM", tone: "info" },
  { day: 15, title: "Family dinner", sub: "Tomorrow · 6:30 PM", tone: "primary" },
  { day: 17, title: "Maya — recital", sub: "Fri · 7:00 PM", tone: "berry" },
  { day: 19, title: "Pediatrician", sub: "Sun · 9:15 AM", tone: "info" },
];
const EVENT_DAYS = new Set([14, 15, 17, 19, 22]);

export function CalendarPanel() {
  const weeks: (number | null)[][] = [];
  let week: (number | null)[] = [null, null, null]; // May 2026 starts Friday
  for (let d = 1; d <= 31; d++) {
    week.push(d);
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="font-semibold">May 2026</span>
        <div className="flex items-center gap-1">
          <button className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent">
            <ChevronLeft size={15} />
          </button>
          <button className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent">Today</button>
          <button className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent">
            <ChevronRight size={15} />
          </button>
        </div>
      </div>

      <div>
        <div className="grid grid-cols-7 text-center text-[11px] font-medium text-muted-foreground">
          {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
            <div key={i} className="py-1">
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-y-0.5">
          {weeks.flat().map((d, i) => (
            <div key={i} className="relative grid aspect-square place-items-center">
              {d && (
                <span
                  className={`grid size-7 place-items-center rounded-md font-mono text-[12px] tabular-nums ${
                    d === 14 ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-accent"
                  }`}
                >
                  {d}
                </span>
              )}
              {d && EVENT_DAYS.has(d) && d !== 14 && (
                <span className="absolute bottom-0.5 size-1 rounded-full bg-primary" />
              )}
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Up next</div>
        <div className="flex flex-col gap-1.5">
          {UP_NEXT.map((e, i) => (
            <div key={i} className="flex gap-2.5 rounded-md p-1.5 hover:bg-accent/60">
              <span className="w-0.5 shrink-0 rounded-full" style={{ background: `hsl(${TONE_COLOR[e.tone]})` }} />
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium">{e.title}</div>
                <div className="font-mono text-[11.5px] text-muted-foreground">{e.sub}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const TASKS = [
  { title: "Renew home insurance", due: "Today", who: "Maya", high: true },
  { title: "Schedule Lily's checkup", due: "Tomorrow", who: "Daniel" },
  { title: "Buy gift for Nora", due: "May 18", who: "Maya" },
  { title: "Pick up dry cleaning", due: "May 19", who: "Daniel" },
];
const DONE = [
  { title: "Sort tax documents", who: "Daniel" },
  { title: "Order soccer cleats", who: "Maya" },
];

export function TasksPanel() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <span className="font-semibold">Family tasks</span>
        <span className="font-mono text-xs text-muted-foreground">{TASKS.length} open · {DONE.length} done</span>
      </div>

      <div className="flex flex-col gap-1">
        {TASKS.map((t, i) => (
          <div key={i} className="flex items-start gap-2.5 rounded-md p-1.5 hover:bg-accent/60">
            <Checkbox className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-medium">{t.title}</div>
              <div className="mt-1 flex items-center gap-1.5">
                <span
                  className={`font-mono text-[11.5px] ${t.high ? "font-semibold text-destructive" : "text-muted-foreground"}`}
                >
                  {t.due}
                </span>
                {t.high && (
                  <Badge variant="outline" className="border-destructive/40 px-1 py-0 text-[10px] text-destructive">
                    High
                  </Badge>
                )}
              </div>
            </div>
            <PersonAvatar name={t.who} size="xs" />
          </div>
        ))}
      </div>

      <div>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Done</div>
        <div className="flex flex-col gap-1 opacity-70">
          {DONE.map((t, i) => (
            <div key={i} className="flex items-center gap-2.5 rounded-md p-1.5">
              <Checkbox defaultChecked className="mt-0" />
              <span className="flex-1 text-[13.5px] line-through">{t.title}</span>
              <PersonAvatar name={t.who} size="xs" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
