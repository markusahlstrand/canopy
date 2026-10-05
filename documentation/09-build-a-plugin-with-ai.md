# Build a plugin with AI

The drive's Plugins dialog has a **Build with AI** prompt handoff. Describe a file viewer or standalone app, copy the generated prompt into a coding tool, then paste its two outputs into Plugin Studio: `canopy.json` and a single JavaScript entry module. The drive validates the manifest and asks you to approve capabilities before installation. It does not call an AI provider itself.

The entry runs in an opaque-origin iframe. It exports `render(ctx)` as its default function and receives only `ctx.container`, an optional `ctx.file`, and `ctx.emit`. A viewer needs `item:read`; an editor also needs `item:write` and saves through `ctx.emit('save', {content})` when `ctx.file.writable` is true. A standalone app declares `contributes.detailView`. Use a bundled, self-contained entry: relative imports cannot resolve from the saved source.

You can also import a public GitHub repository or a ZIP in Studio. Review the resulting code and capabilities before installing it for yourself or the current space. [Writing a plugin](05-writing-a-plugin.md) describes validation and packaging.
