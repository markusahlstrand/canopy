# Documentation

Renders Canopy's own documentation — the page you're reading right now.

## What it does

The Documentation plugin lists the markdown files in the read-only `documentation` storage
mount and renders the selected one, including ```mermaid diagrams. The open page lives in
the URL (`?doc=<slug>`) so it's deep-linkable and survives a refresh, and links between
pages navigate in-app rather than reloading. It doubles as the landing experience for
signed-out visitors.

## At a glance

- **Type:** App (sidebar detail view)
- **Contributes:** a detail view
- **Capabilities:** `storage:read`, restricted to the `documentation` mount
- **Availability:** in the store; given to signed-out visitors by default, optional for
  signed-in users
- **Category:** Help

## See also

- [Storage and files](storage-and-files) — storage mounts and the `storage:read` capability.
- [Built-in plugins](built-in-plugins) — the rest of what ships with Canopy.
