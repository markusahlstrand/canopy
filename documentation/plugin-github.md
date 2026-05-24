# GitHub

A **data source** that feeds a repository's activity into [Tasks](plugin-tasks) and
[Calendar](plugin-calendar).

## What it does

Point GitHub at a repository and it provides two typed record streams to the host: open
issues become **tasks**, and releases and milestones become **calendar events**. The
data-source role runs trusted, server-side (it's the I/O boundary), backed by the
`@canopy/connector-github` connector, and caches results for five minutes to stay well
under the API rate limit. Public repos work with no token; a personal access token unlocks
private repos and higher limits.

## Configuration

| Field | Notes |
|---|---|
| Repository | `owner/repo` or a github.com URL (required) |
| Branch | defaults to `main` |
| Token | personal access token — only for private repos or higher rate limits (stored as a secret) |

## At a glance

- **Type:** App + data source (provides `tasks` and `calendar`)
- **Contributes:** a detail view and a data source
- **Capabilities:** `net:fetch` restricted to `api.github.com`
- **Availability:** in the store, not installed by default
- **Category:** Productivity

## See also

- [Tasks](plugin-tasks) and [Calendar](plugin-calendar) — where its records show up.
- [Writing a plugin](writing-a-plugin) — building a data source / connector.
