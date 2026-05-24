# Calendar

A shared calendar surfaced as a full detail view and a right-rail **"Up next"** panel.

## What it does

Calendar owns no data of its own — it reads events through the host's calendar capability
and renders them. When a data source like [GitHub](plugin-github) is connected, it shows
live events (releases, milestones); otherwise it falls back to project-flavoured sample
data so the surface is never empty. A **"Add to calendar"** action appears in the context
menu for documents, notes, and PDFs.

## At a glance

- **Type:** App (sidebar detail view + right-rail panel)
- **Contributes:** a detail view, a rail panel (`Calendar`), and a context-menu action
  (`Add to calendar`, on PDF / document / note items)
- **Capabilities:** none of its own — reads events via the host
- **Availability:** in the store, **installed by default**
- **Category:** Productivity

## See also

- [Tasks](plugin-tasks) — its task-list sibling, fed by the same sources.
- [GitHub](plugin-github) — connect a repo to populate the calendar with live events.
- [How plugins work](how-plugins-work) — data sources and the rail/detail-view roles.
