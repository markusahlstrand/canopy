# canopy-plugin-sample

The reference npm-distributed Canopy plugin. In Plugin Studio choose the npm source, enter
`canopy-plugin-sample` (optionally a version or tag) and review it.

What the importer enforces: the manifest lives in `package.json` under `canopy`; `canopy.entry` is a
plain relative path to a self-contained ES module (no `import` / `export ... from`); the registry
release has a SHA-512 integrity value; the tarball is served by registry.npmjs.org.

The local browser acceptance suite (`pnpm test:e2e -- e2e/plugins.spec.ts`) packs this folder with
`npm pack` and serves it from a loopback registry. That is local evidence only. Publishing to the
real registry is a manual step: `cd examples/npm/canopy-plugin-sample && npm publish --access public`.
