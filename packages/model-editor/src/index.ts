// Public surface of the Model Editor plugin: the file router (dispatches a
// .prisma/.tsp/.arazzo file to the right canvas) and the domain-model
// vocabulary. Hosts (the Canopy portal, the VS Code extension) render
// `ModelEditorFileRouter` inside a `PluginHostProvider` and supply a HostBridge.
export { ModelEditorFileRouter } from "./file-router";
export * from "./types";
