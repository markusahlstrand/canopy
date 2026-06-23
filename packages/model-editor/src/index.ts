// Public surface of the Model Editor plugin: the file router (dispatches a
// .prisma/.tsp/.arazzo/.asyncapi file to the right canvas) and the domain-model
// vocabulary. Hosts (the Canopy portal, the VS Code extension) render
// `ModelEditorFileRouter` inside a `PluginHostProvider` and supply a HostBridge.
export { ModelEditorFileRouter } from "./file-router";
export * from "./types";
// The shared "Pet Store" starter project, used by the VS Code "Create Sample
// Project" command and the demo's "Try a sample" so the two stay in sync.
export { SAMPLE_PROJECT, SAMPLE_ENTRYPOINT, type SampleFile } from "./sample-project";
