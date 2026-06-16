# Canopy API — TypeSpec spec

A starter [TypeSpec](https://typespec.io) contract for the Canopy drive HTTP API,
plus an [Arazzo](https://spec.openapis.org/arazzo/latest.html) workflow that
describes a multi-step flow over it. Intentionally **partial** — it covers the
fundamentals (spaces, files + versions, the upload flow, search) and leaves
connectors, sharing, comments, plugins, MCP and AI endpoints for later.

## Files

| File | What it is |
| --- | --- |
| `main.tsp` | Service definition: routes + operations. |
| `models.tsp` | Data models (`Space`, `File`, `FileVersion`, `SearchHit`, …). |
| `tspconfig.yaml` | Emitter config — emits OpenAPI 3 to `openapi.yaml`. |
| `openapi.yaml` | Generated OpenAPI 3 document (checked in for convenience). |
| `upload-file.arazzo.yaml` | Arazzo workflow: prepare → upload → create → confirm. |

## Regenerate the OpenAPI

```sh
# from this directory, with the TypeSpec toolchain available
npx -p @typespec/compiler -p @typespec/http -p @typespec/openapi -p @typespec/openapi3 \
  tsp compile .
```

`openapi.yaml` is the source the Arazzo workflow points at via `sourceDescriptions`.
