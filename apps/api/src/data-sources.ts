import type { CalendarProvider, ConnectorConfigField, TaskProvider } from "@canopy/core";
import { createGithubCalendarProvider, createGithubTaskProvider } from "@canopy/connector-github";

/**
 * Server-side registry of installable **data-source plugins**. Each declares its
 * config schema (rendered as a generic settings form in the portal) and knows how
 * to build typed providers from a saved config. This is the authoritative schema
 * — secrets never need to round-trip to the client to render the form.
 */
export interface ServerDataSource {
  id: string;
  configFields: ConnectorConfigField[];
  /** Build providers from a resolved (decrypted) config; returns what it can. */
  build(config: Record<string, string>): { tasks?: TaskProvider; calendar?: CalendarProvider };
}

/** Parse "owner/repo" or a github.com URL into { owner, repo }. */
export function parseRepo(input: string): { owner: string; repo: string } | null {
  const s = input.trim().replace(/\.git$/, "");
  const m = s.match(/github\.com[/:]([^/]+)\/([^/]+)/) ?? s.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}

export const githubDataSource: ServerDataSource = {
  id: "github",
  configFields: [
    { key: "repo", label: "Repository (owner/repo or URL)", type: "url", required: true },
    { key: "branch", label: "Branch (default: main)", type: "string" },
    { key: "token", label: "Personal access token — only for private repos or higher rate limits", type: "secret" },
  ],
  build(config) {
    const parsed = parseRepo(config.repo ?? "");
    if (!parsed) return {};
    const cfg = { owner: parsed.owner, repo: parsed.repo, branch: config.branch || undefined, token: config.token || undefined };
    return {
      tasks: createGithubTaskProvider("github", cfg),
      calendar: createGithubCalendarProvider("github", cfg),
    };
  },
};

export const DATA_SOURCES: ServerDataSource[] = [githubDataSource];
