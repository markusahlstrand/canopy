# Calendar

A calendar surfaced as a full detail view and a right-rail **"Up next"** panel — over
both your **own** calendars and any connected data source.

## What it does

Calendar renders an aggregated stream of events: your **owned** calendars (events you
create and store in Canopy) plus live events from any connected [data source](how-plugins-work)
like [GitHub](plugin-github) (releases, milestones). It owns no rendering data of its own —
it reads the merged stream through the host's calendar capability. With nothing connected
and nothing created, it falls back to project-flavoured sample data so the surface is never
empty. A **"Add to calendar"** action appears in the context menu for documents, notes, and
PDFs.

## Calendars are folders

A **calendar is a virtual folder** ([Sharing and spaces](sharing-and-spaces)). Creating a
calendar creates a colored folder in a space; adding an event stores it at that folder's
path. This means scheduling reuses the drive's identity and permission model wholesale:

- **Sharing a calendar is a folder grant** — share it with specific people (by email) or
  with a whole group space, exactly like sharing a folder of files, with the same downward
  inheritance.
- **A space has 0–n calendars** (its calendar folders) plus an **implicit root calendar**,
  so "add an event to my Personal space" always has a home.
- **Tags (`keywords`)** classify events for filtering and color; they carry no permission
  meaning — that's the folder's job.

Events and tasks live in their own tables, never as files, so they never show up in the
drive's file tree — calendars are their own surface. But because a calendar folder can also
hold documents, one share covers a folder's files *and* its scheduling items.

The canonical record shape is [JSCalendar (RFC 8984)](https://www.rfc-editor.org/rfc/rfc8984):
events and tasks are stored as JSCalendar objects, projected to the flat shape the plugin
renders at read time — the same shape a future iCal/CalDAV import would up-convert to.

## At a glance

- **Type:** App (sidebar detail view + right-rail panel)
- **Contributes:** a detail view, a rail panel (`Calendar`), and a context-menu action
  (`Add to calendar`, on PDF / document / note items)
- **Capabilities:** none of its own — reads the aggregated stream via the host
- **Owns:** calendars (= folders), events, and tasks you create, stored in your spaces
- **Availability:** in the store, **installed by default**
- **Category:** Productivity

## See also

- [Tasks](plugin-tasks) — its task-list sibling, fed by the same owned + connected sources.
- [GitHub](plugin-github) — connect a repo to populate the calendar with live events.
- [Sharing and spaces](sharing-and-spaces) — folders, folder grants, and how a calendar shares.
- [How plugins work](how-plugins-work) — data sources and the rail/detail-view roles.
