import type { ServerDataSource, StorageConnector } from "@canopy/core";
import { createGithubCalendarProvider, createGithubTaskProvider } from "@canopy/connector-github";
import { synologyConnectorPlugin } from "@canopy/connector-synology";

// The GitHub data source — the `data-source` role (typed records into Tasks /
// Calendar) of the first-party GitHub plugin. Its contract (`ServerDataSource`)
// lives in @canopy/core alongside the other role contracts; see plugins.ts for
// how the role is bundled into one plugin.

/** Parse "owner/repo" or a github.com URL into { owner, repo }. */
export function parseRepo(input: string): { owner: string; repo: string } | null {
  const s = input.trim().replace(/\.git$/, "");
  const m = s.match(/github\.com[/:]([^/]+)\/([^/]+)/) ?? s.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}

const GITHUB_TTL_MS = 5 * 60 * 1000;

export const githubDataSource: ServerDataSource = {
  id: "github",
  configFields: [
    { key: "repo", label: "Repository (owner/repo or URL)", type: "url", required: true },
    { key: "branch", label: "Branch (default: main)", type: "string" },
    { key: "token", label: "Personal access token — only for private repos or higher rate limits", type: "secret" },
  ],
  build(config, ctx) {
    const parsed = parseRepo(config.repo ?? "");
    if (!parsed) return {};
    const cfg = { owner: parsed.owner, repo: parsed.repo, branch: config.branch || undefined, token: config.token || undefined };
    const raw = {
      tasks: createGithubTaskProvider("github", cfg),
      calendar: createGithubCalendarProvider("github", cfg),
    };
    const cache = ctx?.cache;
    const repoKey = `${parsed.owner}/${parsed.repo}`;
    // GitHub's chosen policy: 5-minute TTL, to stay well under the API rate limit.
    return {
      tasks: {
        id: "github",
        listTasks: () =>
          cache ? cache.wrap(`tasks:${repoKey}`, GITHUB_TTL_MS, () => raw.tasks.listTasks()) : raw.tasks.listTasks(),
      },
      calendar: {
        id: "github",
        listEvents: (range) =>
          cache
            ? cache.wrap(`calendar:${repoKey}:${range.from}:${range.to}`, GITHUB_TTL_MS, () => raw.calendar.listEvents(range))
            : raw.calendar.listEvents(range),
      },
    };
  },
};

// The Synology plugin's only role is the storage connector (see connectorFor in
// node.ts / worker.ts). Registering it as a "data source" with no tasks/calendar
// is just how a connector-only plugin gets a settings form (its config schema)
// and a connected space today — the same machinery GitHub uses. The config
// schema is the connector's own, so the two never drift.
export const synologyDataSource: ServerDataSource = {
  id: "synology",
  configFields: synologyConnectorPlugin.configFields,
  build: () => ({}),
};

/**
 * Build a Synology {@link StorageConnector} from a resolved config, or null when
 * the config is incomplete (no address / credentials) — so an un-set-up plugin
 * simply has no connected space rather than erroring.
 */
export function synologyConnectorFor(config: Record<string, string>): StorageConnector | null {
  try {
    return synologyConnectorPlugin.create("connector:synology", config);
  } catch {
    return null;
  }
}
