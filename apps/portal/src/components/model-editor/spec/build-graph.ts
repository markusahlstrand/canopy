// Combine the parsed layers into one normalised ProjectGraph and run the cross-layer
// validation that a unified editor can do but three separate tools cannot: a flow
// step bound to an operationId that no operation provides, an Arazzo source url that
// resolves to nothing, and (from the TypeSpec pass) operations referencing models
// that no longer exist.

import { parseArazzo } from "./arazzo";
import type { DiscoveredFiles } from "./discover";
import { parseOpenApi } from "./openapi";
import { compileTypeSpec } from "./typespec";
import { type Diagnostic, type ProjectGraph, type SourceFile, type SpecFlow, type SpecSource } from "./graph-types";

const basename = (p: string) => p.replace(/[#?].*$/, "").split("/").pop()!.trim();

export async function buildProjectGraph(files: DiscoveredFiles): Promise<ProjectGraph> {
  const diagnostics: Diagnostic[] = [];

  // ── Contract: TypeSpec models + endpoints ──
  const { models, endpoints, diagnostics: tspDiag } = await compileTypeSpec(files.tsp);
  diagnostics.push(...tspDiag);

  // ── OpenAPI: operationId sets per emitted file (for source resolution + validation) ──
  const openapiByName = new Map(files.openapi.map((f) => [f.name, parseOpenApi(f.text)] as const));
  const openapiOps = new Set<string>();
  for (const info of openapiByName.values()) for (const id of info.operations.keys()) openapiOps.add(id);

  // The complete set of operationIds a flow step can legitimately bind to.
  const knownOps = new Set<string>([...endpoints.map((e) => e.operationId), ...openapiOps]);

  // ── Workflows: parse every Arazzo doc ──
  const flows: SpecFlow[] = [];
  const sources: SpecSource[] = [];
  for (const f of files.arazzo) {
    const res = parseArazzo(f.text, f.name);
    if (!res.isArazzo) continue;
    flows.push(...res.flows);
    diagnostics.push(...res.diagnostics);

    // Resolve each source description's url to a local OpenAPI file by basename.
    for (const src of res.sources) {
      const target = src.url ? files.openapi.find((o) => o.name === basename(src.url)) : undefined;
      const resolved = !!target;
      sources.push({ ...src, resolved, resolvedFileId: target?.id });
      if (!resolved && src.type !== undefined && src.type !== "openapi") continue;
      if (!resolved) {
        diagnostics.push({
          severity: "warning",
          layer: "arazzo",
          message: `Source "${src.name}" url "${src.url}" didn't resolve to an OpenAPI file in this folder.`,
          file: f.name,
        });
      }
    }

    // Validate every step's operation binding against the known operationIds.
    for (const flow of res.flows) {
      for (const step of flow.steps) {
        if (!step.operationId) continue;
        if (!knownOps.has(step.operationId)) {
          diagnostics.push({
            severity: "error",
            layer: "link",
            message: `Step "${step.stepId}" binds to operationId "${step.operationId}", which no operation provides.`,
            target: { kind: "step", id: step.id },
            file: f.name,
          });
        }
      }
    }
  }

  const sourceFiles: SourceFile[] = [
    ...files.tsp.map((f) => ({ id: f.id, name: f.name, kind: "tsp" as const, text: f.text })),
    ...files.openapi.map((f) => ({ id: f.id, name: f.name, kind: "openapi" as const, text: f.text })),
    ...files.arazzo.map((f) => ({ id: f.id, name: f.name, kind: "arazzo" as const, text: f.text })),
  ];

  const empty = models.length === 0 && endpoints.length === 0 && flows.length === 0;
  return {
    models,
    endpoints,
    flows,
    sources,
    diagnostics,
    files: {
      tsp: files.tsp.map((f) => f.name),
      openapi: files.openapi.map((f) => f.name),
      arazzo: files.arazzo.map((f) => f.name),
    },
    sourceFiles,
    empty,
  };
}
