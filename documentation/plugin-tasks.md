# Tasks

A shared to-do list for the household, opened from the sidebar.

## What it does

Tasks renders a typed list of to-dos as a detail view. Like [Calendar](plugin-calendar) it
owns no data — it shows live tasks once a data source such as [GitHub](plugin-github) is
connected (e.g. open issues), and project-flavoured sample tasks otherwise. From any file
you can run **"Create task from file"** in the context menu to turn a document into a task.

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
