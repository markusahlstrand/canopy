# Model Editor

<code>@canopy/model-editor</code> is a visual editor for model and API files such as Prisma and TypeSpec. Its earlier integration into the Canopy portal retired with that app; it is not currently a file viewer in the Substrat drive vertical.

Two independent hosts remain in the repository: the [VS Code extension](../apps/vscode-model-editor/README.md) and the [standalone demo](../apps/model-editor-demo/README.md). Both use the editor package without the retired portal. A future drive integration depends on the viewer and plugin boundary in [#73](https://github.com/markusahlstrand/canopy/issues/73).
