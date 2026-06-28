# Tasks

A shared to-do list for the household, opened from the sidebar.

## What it does

Tasks renders a typed list of to-dos as a detail view. It shows your **owned** tasks (work
items you create, stored in a calendar — see [Calendar](plugin-calendar)) merged with live
tasks from a connected data source such as [GitHub](plugin-github) (e.g. open issues), and
project-flavoured sample tasks when there's nothing yet. From any file you can run **"Create
task from file"** in the context menu to turn a document into a task.

Owned tasks are JSCalendar Tasks: completion-bearing (a `status` and a `percentComplete`),
with optional `start`/`due`. They live in a calendar (a virtual folder), so they inherit that
folder's sharing — the same model as events.

## At a glance

- **Type:** App (sidebar detail view)
- **Contributes:** a detail view and a context-menu action (`Create task from file`)
- **Capabilities:** `item:read`
- **Availability:** in the store, **installed by default**
- **Category:** Productivity

## See also

- [Calendar](plugin-calendar) — the companion calendar view.
- [GitHub](plugin-github) — the data source that fills Tasks with live issues.
- [How plugins work](how-plugins-work) — the data-source and detail-view roles.
