# Writing a plugin

Plugin authoring for the current Substrat drive vertical is undecided. The old portal and its sandboxed iframe host have been retired, so its viewer registration and Plugin Studio instructions no longer produce a working addition to the drive.

Follow [#73: Web components and the hosted vertical](https://github.com/markusahlstrand/canopy/issues/73) for the replacement contract. The legacy examples remain in <code>examples/plugins</code> as source material, not a supported install path for the running vertical.

### Validate a plugin before importing it

Run `pnpm plugin:validate path/to/plugin` (or pass its `canopy.json`). The command
checks the canonical manifest schema and verifies that the declared entry exists
inside the plugin directory. It does not execute plugin code. Invalid manifests,
missing entries, and escaped entry paths exit nonzero, so the same command works in CI.
This validates declarations and packaging; it does not certify a plugin as trusted.

The entry must be a plain relative path such as `index.js` or `dist/main.js`:
no leading `./`, no `..`, no empty segments and no backslashes. Loaders look the
entry up literally, so a path that needs normalising would pass here and fail
(or resolve elsewhere) on import.

Pass `--manifest-only` for a plugin whose code ships with the host, like
`examples/plugins/model-editor`; it checks the manifest and skips the entry.
The package's tests validate every plugin under `examples/plugins`.

The legacy `POST /api/plugins/custom` endpoint (Plugin Studio, in `apps/api`)
applies extra rules this command does not: only the `item:read`, `item:write` and
`net:fetch` capabilities, at least one viewer or a `detailView`, and a kebab-case id of 2–49
characters. Passing here does not mean that endpoint will accept the manifest.
