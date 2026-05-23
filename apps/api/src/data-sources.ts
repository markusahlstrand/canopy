import type { CacheStore, CalendarProvider, ConnectorConfigField, TaskProvider } from "@canopy/core";
import { createGithubCalendarProvider, createGithubTaskProvider } from "@canopy/connector-github";

/**
 * Server-side registry of installable **data-source plugins**. Each declares its
 * config schema (rendered as a generic settings form in the portal) and knows how
 * to build typed providers from a saved config. This is the authoritative schema
 * — secrets never need to round-trip to the client to render the form.
 *
 * The adapter owns its own **caching policy**: `build` receives an (already
 * scoped) CacheStore and decides what/how long to cache. The host just hands it a
 * namespace-isolated cache; it works the same on SQLite locally and the Cache API
 * on Cloudflare.
 */
export interface ServerDataSource {
  id: string;
  configFields: ConnectorConfigField[];
  /** Build providers from a resolved (decrypted) config; returns what it can. */
  build(config: Record<string, string>, ctx?: { cache?: CacheStore }): { tasks?: TaskProvider; calendar?: CalendarProvider };
}

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

export const DATA_SOURCES: ServerDataSource[] = [githubDataSource];
