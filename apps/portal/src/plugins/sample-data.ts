import type { CalendarEvent, Task } from "@/lib/api";

/**
 * Project/team-flavored placeholder data shown until a real source (the GitHub
 * plugin) is connected. Mirrors what live GitHub issues/releases/milestones look
 * like once mapped, so the UI reads coherently in either state.
 */
export const SAMPLE_TASKS: Task[] = [
  { id: "s1", title: "Wire up billing webhooks", status: "todo", assignee: "markus", priority: "high", labels: ["backend"] },
  { id: "s2", title: "Audit client bundle size", status: "todo", assignee: "lena", labels: ["perf"] },
  { id: "s3", title: "Draft Q3 roadmap", status: "todo", assignee: "sam" },
  { id: "s4", title: "Migrate auth to OIDC BFF", status: "in_progress", assignee: "markus", labels: ["auth"] },
  { id: "s5", title: "Build read-only WebDAV mount", status: "in_progress", assignee: "lena", priority: "high" },
  { id: "s6", title: "Enable R2 cross-region replication", status: "blocked", assignee: "sam", labels: ["infra"] },
  { id: "s7", title: "Ship the plugin store", status: "done", assignee: "markus" },
  { id: "s8", title: "Add the command palette", status: "done", assignee: "lena" },
];

/** Sample events anchored to "now" so they always land in the current window. */
export function sampleEvents(): CalendarEvent[] {
  const day = 864e5;
  const now = Date.now();
  const at = (offsetDays: number) => new Date(now + offsetDays * day).toISOString();
  return [
    { id: "se1", title: "v0.3.0", start: at(-21), kind: "release", tone: "primary" },
    { id: "se2", title: "v0.4.0", start: at(-4), kind: "release", tone: "primary" },
    { id: "se3", title: "Public demo", start: at(5), allDay: true, kind: "milestone", tone: "info" },
    { id: "se4", title: "Beta launch", start: at(16), allDay: true, kind: "milestone", tone: "info" },
    { id: "se5", title: "v0.5.0", start: at(30), kind: "release", tone: "primary" },
  ];
}
