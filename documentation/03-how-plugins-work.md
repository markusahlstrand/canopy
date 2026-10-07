# How plugins work

The drive vertical in `apps/drive-vertical` loads file viewers and full-view apps at runtime. Open **Plugins** from the drive to browse the bundled catalog, import a plugin, or edit a source in Plugin Studio. Installs can apply to one person or to the current space. A personal install takes precedence over the same plugin installed for the space; disabling it also disables that contribution for that person.

A plugin has a `canopy.json` manifest and a self-contained JavaScript entry. `contributes.viewers` registers file-type matches; `contributes.detailView` adds an app to the rail and command palette. The manifest declares `item:read`, `item:write`, or public `net:fetch` capabilities as needed. Studio validates the manifest and asks for capability approval before saving. Imported GitHub, npm, and ZIP sources are resolved before that review step.

Runtime code runs in an opaque-origin iframe through the [plugin SDK](../packages/plugin-sdk). It receives only the host context and capabilities granted to that install. The built-in image viewer is a trusted component compiled into the drive; it does not use the iframe. Search remains part of the drive UI while [#22](https://github.com/markusahlstrand/canopy/issues/22) settles whether it should become a removable first-party contribution.

For the manifest, entry format, validation command, and import flow, see [Writing a plugin](05-writing-a-plugin.md). The old `apps/portal` registration files are retired and are not an installation path.
