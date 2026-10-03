# Writing a plugin

Plugin authoring for the current Substrat drive vertical is undecided. The old portal and its sandboxed iframe host have been retired, so its viewer registration and Plugin Studio instructions no longer produce a working addition to the drive.

Follow [#73: Web components and the hosted vertical](https://github.com/markusahlstrand/canopy/issues/73) for the replacement contract. The legacy examples remain in <code>examples/plugins</code> as source material, not a supported install path for the running vertical.

### Validate a plugin before importing it

Run `pnpm plugin:validate path/to/plugin` (or pass its `canopy.json`). The command
checks the canonical manifest schema and verifies that the declared entry exists
inside the plugin directory. It does not execute plugin code. Invalid manifests,
missing entries, and escaped entry paths exit nonzero, so the same command works in CI.
This validates declarations and packaging; it does not certify a plugin as trusted.
