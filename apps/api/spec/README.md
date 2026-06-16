# Canopy API — TypeSpec spec

The [TypeSpec](https://typespec.io) contract for the `@canopy/api` HTTP surface
(the routes served by [`src/app.ts`](../src/app.ts)), plus
[Arazzo](https://spec.openapis.org/arazzo/latest.html) workflows that describe
multi-step flows over it. Lives in the package that serves the API so it stays
next to the implementation it defines.

Intentionally **partial** for now — it covers the fundamentals (spaces, files +
versions, the upload flow, search) and leaves connectors, sharing, comments,
plugins, MCP and AI endpoints for later.

## Files

| File | What it is |
| --- | --- |
| `main.tsp` | Service definition: routes + operations. |
| `models.tsp` | Data models (`Space`, `File`, `FileVersion`, `SearchHit`, …). |
| `tspconfig.yaml` | Emitter config — emits OpenAPI 3 to `openapi.yaml`. |
| `openapi.yaml` | Generated OpenAPI 3 document (checked in for convenience). |
| `upload-file.arazzo.yaml` | Arazzo workflow: prepare → upload → create → confirm. |
| `share-and-find.arazzo.yaml` | Arazzo workflow: create a space → (reuse the upload flow) → search until the file is indexed. |

## Regenerate the OpenAPI

The TypeSpec toolchain is a dev dependency of `@canopy/api`, so from the repo root:

```sh
pnpm --filter @canopy/api spec
```

This runs `tsp compile spec` and rewrites `openapi.yaml` in place.

`openapi.yaml` is the source the Arazzo workflows point at via `sourceDescriptions`.
`share-and-find.arazzo.yaml` also declares `upload-file.arazzo.yaml` as an `arazzo`
source so it can reuse the `uploadFileToSpace` workflow as a single step.
