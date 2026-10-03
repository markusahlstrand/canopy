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

Pass `--generated` to also apply the legacy `POST /api/plugins/custom` manifest
rules: only `item:read`, `item:write` and `net:fetch`, at least one viewer or a
`detailView`, and a kebab-case id of 2–49 characters. The CLI and endpoint share
this validation function. Default validation covers the broader portable manifest
schema; endpoint acceptance also depends on the submitted source and authorization.

For CI or an authoring tool, add `--json` to print one JSON object to stdout:

```sh
pnpm --silent plugin:validate --json examples/plugins/image-viewer
```

The report has `formatVersion: 1`, `valid`, an `errors` array, the validation
`profile` (`portable` or `generated`), and `manifestOnly`. Successful reports also
include `plugin: { id, version }`. Errors, including unreadable files and invalid
arguments, use the same JSON format without stderr diagnostics. Exit codes remain
0 for valid input, 1 for validation or file errors, and 2 for incorrect arguments.
Use `--silent` with pnpm, or invoke `node packages/plugin-validator/src/cli.mjs`
directly, so the package runner's banner does not precede the JSON report.
