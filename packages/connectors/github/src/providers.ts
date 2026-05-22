import type {
  CalendarEvent,
  CalendarProvider,
  CalendarRange,
  Task,
  TaskProvider,
  TaskStatus,
} from "@canopy/core";
import type { GithubConnectorConfig } from "./index";

/**
 * GitHub as a typed data source: issues become tasks and milestones/releases
 * become calendar events. Read-only over the public REST API; pass a `token`
 * for higher rate limits or private repos. These are the provider siblings of
 * the storage connector in ./index.ts — same config, different surface.
 */

interface GhUser {
  login: string;
}
interface GhLabel {
  name: string;
}
interface GhMilestone {
  title: string;
  due_on: string | null;
  html_url: string;
}
interface GhIssue {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  assignee: GhUser | null;
  labels: (GhLabel | string)[];
  milestone: GhMilestone | null;
  pull_request?: unknown; // present only on PRs — we skip those
}
interface GhRelease {
  name: string | null;
  tag_name: string;
  html_url: string;
  draft: boolean;
  published_at: string | null;
  created_at: string;
}

function ghHeaders(config: GithubConnectorConfig): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "canopy" };
  if (config.token) h.Authorization = `Bearer ${config.token}`;
  return h;
}

async function ghGet<T>(config: GithubConnectorConfig, path: string): Promise<T> {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/${path}`;
  const res = await fetch(url, { headers: ghHeaders(config) });
  if (!res.ok) throw new Error(`github ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

const labelNames = (labels: (GhLabel | string)[]): string[] =>
  labels.map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);

/** Map issue state + labels to a normalized task status. */
function statusOf(issue: GhIssue, labels: string[]): TaskStatus {
  if (issue.state === "closed") return "done";
  const has = (re: RegExp) => labels.some((l) => re.test(l.toLowerCase()));
  if (has(/blocked/)) return "blocked";
  if (has(/in[\s:-]*progress|wip|doing/)) return "in_progress";
  return "todo";
}

function priorityOf(labels: string[]): Task["priority"] {
  const has = (re: RegExp) => labels.some((l) => re.test(l.toLowerCase()));
  if (has(/p0|priority[\s:-]*high|high[\s-]*priority|urgent/)) return "high";
  if (has(/p3|priority[\s:-]*low|low[\s-]*priority/)) return "low";
  return "normal";
}

export function createGithubTaskProvider(id: string, config: GithubConnectorConfig): TaskProvider {
  return {
    id,
    async listTasks(): Promise<Task[]> {
      const issues = await ghGet<GhIssue[]>(config, "issues?state=all&per_page=100&sort=updated");
      return issues
        .filter((it) => !it.pull_request) // issues only — drop PRs
        .map((it) => {
          const labels = labelNames(it.labels);
          return {
            id: String(it.number),
            title: it.title,
            status: statusOf(it, labels),
            assignee: it.assignee?.login,
            due: it.milestone?.due_on ?? undefined,
            labels,
            priority: priorityOf(labels),
            url: it.html_url,
          } satisfies Task;
        });
    },
  };
}

export function createGithubCalendarProvider(id: string, config: GithubConnectorConfig): CalendarProvider {
  return {
    id,
    async listEvents(range: CalendarRange): Promise<CalendarEvent[]> {
      const [milestones, releases] = await Promise.all([
        ghGet<GhMilestone[]>(config, "milestones?state=all&per_page=100"),
        ghGet<GhRelease[]>(config, "releases?per_page=100"),
      ]);

      const events: CalendarEvent[] = [];
      for (const m of milestones) {
        if (!m.due_on) continue;
        events.push({
          id: `ms:${m.html_url}`,
          title: m.title,
          start: m.due_on,
          allDay: true,
          kind: "milestone",
          url: m.html_url,
          tone: "info",
        });
      }
      for (const r of releases) {
        if (r.draft) continue;
        const start = r.published_at ?? r.created_at;
        events.push({
          id: `rel:${r.tag_name}`,
          title: r.name || r.tag_name,
          start,
          kind: "release",
          url: r.html_url,
          tone: "primary",
        });
      }

      const from = Date.parse(range.from);
      const to = Date.parse(range.to);
      return events
        .filter((e) => {
          const t = Date.parse(e.start);
          return t >= from && t < to;
        })
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    },
  };
}
