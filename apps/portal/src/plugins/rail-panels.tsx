import { useState } from "react";
import { TONE_COLOR } from "@/lib/mock-data";
import { useCalendar } from "./data";

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
