// Combine the parsed layers into one normalised ProjectGraph and run the cross-layer
// validation that a unified editor can do but three separate tools cannot: a flow
// step bound to an operationId that no operation provides, an Arazzo source url that
// resolves to nothing, and (from the TypeSpec pass) operations referencing models
// that no longer exist.

import { parseArazzo } from "./arazzo";
import { parseAsyncApi } from "./asyncapi";
import type { DiscoveredFiles } from "./discover";
import { emptySidecar, parseSidecar } from "./layout-sidecar";
import { parseOpenApi } from "./openapi";
import { compileTypeSpec } from "./typespec";
import { type Diagnostic, type ProjectGraph, type SourceFile, type SpecChannel, type SpecEndpoint, type SpecFlow, type SpecModel, type SpecSource } from "./graph-types";

const basename = (p: string) => p.replace(/[#?].*$/, "").split("/").pop()!.trim();

/** Compare two HTTP routes ignoring query strings and trailing slashes. */
const sameRoute = (a?: string, b?: string) => {
  if (!a || !b) return false;
  const norm = (s: string) => s.replace(/[?#].*$/, "").replace(/\/+$/, "") || "/";
  return norm(a) === norm(b);
};

/**
 * Tag each model as a persisted `entity` or a transient `dto`. An entity has identity
 * (`@key`) or is reachable from one through model field references; everything else is
 * a request/response payload that only flows through an operation. We grow the entity
 * set from the `@key`-bearing seeds to a fixpoint: a `Listing` (no key, referenced only
 * by an operation) stays a DTO, while a `File` it embeds is pulled in as an entity.
 */
export function classifyModels(models: SpecModel[]): SpecModel[] {
  const byId = new Map(models.map((m) => [m.id, m] as const));
  const entityIds = new Set(models.filter((m) => m.fields.some((f) => f.key)).map((m) => m.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const id of entityIds) {
      for (const f of byId.get(id)!.fields) {
        if (f.ref && byId.has(f.ref) && !entityIds.has(f.ref)) {
          entityIds.add(f.ref);
          grew = true;
        }
      }
    }
  }
  return models.map((m) => ({ ...m, role: entityIds.has(m.id) ? "entity" : "dto" }));
}

export async function buildProjectGraph(files: DiscoveredFiles): Promise<ProjectGraph> {
  const diagnostics: Diagnostic[] = [];

  // ── Contract: TypeSpec models + endpoints ──
  const { models: rawModels, endpoints, diagnostics: tspDiag } = await compileTypeSpec(files.tsp);
  const models = classifyModels(rawModels);
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

  // ── Events: parse every AsyncAPI doc, then link it to the contract ──
  // Payload refs and the optional `x-operationId` are short names; resolve them to the
  // model ids / endpoints the rest of the graph keys on (mirroring TypeSpec's pass).
  const modelIdByName = new Map<string, string>();
  for (const m of models) {
    modelIdByName.set(m.id, m.id);
    if (!modelIdByName.has(m.name)) modelIdByName.set(m.name, m.id);
  }
  const resolveModel = (name: string) => modelIdByName.get(name) ?? modelIdByName.get(name.split(".").pop()!);
  const endpointByOp = new Map<string, SpecEndpoint>(endpoints.map((e) => [e.operationId, e]));

  const channels: SpecChannel[] = [];
  for (const f of files.asyncapi) {
    const res = parseAsyncApi(f.text, f.name);
    if (!res.isAsyncApi) continue;
    diagnostics.push(...res.diagnostics);
    for (const ch of res.channels) {
      // Rewrite each payload ref from its schema name to the resolved model id so the
      // UI can navigate to the entity; leave it as the raw name when no model matches.
      for (const msg of ch.messages) if (msg.payloadRef) msg.payloadRef = resolveModel(msg.payloadRef) ?? msg.payloadRef;
      ch.refModels = [...new Set(ch.messages.map((m) => m.payloadRef).filter((r): r is string => !!r && modelIdByName.has(r)))];

      // Endpoint link: an explicit `x-operationId` wins; else match the address to a route.
      if (ch.operationIdHint) {
        const ep = endpointByOp.get(ch.operationIdHint);
        if (ep) ch.endpointId = ep.id;
        else {
          diagnostics.push({
            severity: "warning",
            layer: "link",
            message: `Channel "${ch.name}" binds x-operationId "${ch.operationIdHint}", which no operation provides.`,
            target: { kind: "channel", id: ch.id },
            file: f.name,
          });
        }
      }
      if (!ch.endpointId) {
        const match = endpoints.find((e) => sameRoute(e.route, ch.address));
        if (match) ch.endpointId = match.id;
      }
      channels.push(ch);
    }
  }

  const sourceFiles: SourceFile[] = [
    ...files.tsp.map((f) => ({ id: f.id, name: f.name, kind: "tsp" as const, text: f.text })),
    ...files.openapi.map((f) => ({ id: f.id, name: f.name, kind: "openapi" as const, text: f.text })),
    ...files.arazzo.map((f) => ({ id: f.id, name: f.name, kind: "arazzo" as const, text: f.text })),
    ...files.asyncapi.map((f) => ({ id: f.id, name: f.name, kind: "asyncapi" as const, text: f.text })),
  ];

  const empty = models.length === 0 && endpoints.length === 0 && flows.length === 0 && channels.length === 0;
  return {
    models,
    endpoints,
    flows,
    channels,
    sources,
    diagnostics,
    files: {
      tsp: files.tsp.map((f) => f.name),
      openapi: files.openapi.map((f) => f.name),
      arazzo: files.arazzo.map((f) => f.name),
      asyncapi: files.asyncapi.map((f) => f.name),
    },
    sourceFiles,
    layout: files.layout ? parseSidecar(files.layout.text) : emptySidecar(),
    layoutFileId: files.layout?.id,
    empty,
  };
}
