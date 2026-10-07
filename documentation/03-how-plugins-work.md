# How plugins work

The drive vertical in `apps/drive-vertical` loads file viewers and full-view apps at runtime. Open **Plugins** from the drive to browse the bundled catalog, import a plugin, or edit a source in Plugin Studio. Installs can apply to one person or to the current space. A personal install takes precedence over the same plugin installed for the space; disabling it also disables that contribution for that person.

A plugin has a `canopy.json` manifest and a self-contained JavaScript entry. `contributes.viewers` registers file-type matches; `contributes.detailView` adds an app to the rail and command palette. The manifest declares `item:read`, `item:write`, or public `net:fetch` capabilities as needed. Studio validates the manifest and asks for capability approval before saving. Imported GitHub, npm, and ZIP sources are resolved before that review step.

Runtime code runs in an opaque-origin iframe through the [plugin SDK](../packages/plugin-sdk). It receives only the host context and capabilities granted to that install. The host reads the selected file through a permission-checked route; `item:write` requests also check the current revision. The iframe does not receive the Canopy session. **File-read access still lets code disclose the opened file**, so install only plugins you trust. Listed network hosts constrain browser requests, but a plugin can still send data by other browser mechanisms; the approval screen calls this out.

The built-in image viewer is a trusted component compiled into the drive; it does not use the iframe. [The original viewer decision](planning/web-component-viewers.md) describes that boundary but predates the runtime iframe host. [#295](https://github.com/markusahlstrand/canopy/issues/295) tracks deployed acceptance of the current install and runtime flows.

Search stays built into the drive. The command palette is the quick keyboard entry point, while the results view provides a larger list and filters. Both use the drive's permission-checked search path. Search does not appear as an installed plugin and disabling plugins does not remove either entry point. [#292](https://github.com/markusahlstrand/canopy/issues/292) tracks deployed acceptance of both surfaces.

For the manifest, entry format, validation command, and import flow, see [Writing a plugin](05-writing-a-plugin.md). The old `apps/portal` registration files are retired and are not an installation path; installed plugins and data do not migrate automatically.
