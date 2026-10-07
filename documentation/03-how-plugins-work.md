# How plugins work

The Substrat drive vertical includes a bundled plugin catalog and a Plugin Studio. An install applies to one person or the current space. A space install requires permission to manage that space. People can enable or disable installed viewers, and installed full-view apps appear in the rail and command palette.

The catalog bundles reviewed image, Markdown, code, and PDF examples. Studio can import a small ZIP, a public GitHub source, or an npm package, then presents its manifest, source, provenance, and requested capabilities for review. An install or source change requires explicit capability approval. This is a new drive runtime; the retired portal's installed plugins and data do not migrate automatically.

Runtime source runs in an opaque-origin iframe with a restrictive content security policy. The host passes only the selected file bytes and metadata after a permission-checked read. A plugin needs `item:read` to receive a file and `item:write` to request a text save; the host checks the write and version revision. The iframe does not receive the Canopy session. **File-read access still lets code disclose the opened file**, so install only plugins you trust. Listed network hosts constrain browser requests, but a plugin can still send data by other browser mechanisms; the approval screen calls this out.

The built-in image viewer is a separate, trusted web component bundled at build time. It shares the app's origin and is not sandboxed. [The original viewer decision](planning/web-component-viewers.md) describes that boundary but predates the runtime iframe host. [#295](https://github.com/markusahlstrand/canopy/issues/295) tracks deployed acceptance of the current install and runtime flows.

Search stays built into the drive. The command palette is the quick keyboard entry point, while the results view provides a larger list and filters. Both use the drive's permission-checked search path. Search does not appear as an installed plugin and disabling plugins does not remove either entry point. [#292](https://github.com/markusahlstrand/canopy/issues/292) tracks deployed acceptance of both surfaces.
