---
"@canopy/drive-vertical": patch
"@canopy/scope-drive": patch
---

An assistant connected over MCP (Claude Desktop and the like) now reaches every space you are a member of, and your flows (#418). The connection is bound to no space: `drive_list-spaces` lists yours with your role, kind (storage, a3doc, Qonto, …) and whether each is read-only, and every drive tool names the `space` it acts in, with the permissions you have there in the app. A space you are not a member of is refused. Before, every call went to the install's home space, which is why the assistant saw no plugins and no source. New tools list, read, save, delete, preview and run flows, list what flows did and approve or dismiss their proposals, and list every folder of a space by path for a flow's copy steps. Flow tools go through the app's own flow routes, so saving checks the same things: the shared flow schema, owning every space a flow names, and being able to add files to each folder it copies into.
