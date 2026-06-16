// A light OpenAPI reader — just enough to (a) confirm an Arazzo `sourceDescriptions`
// url really points at an OpenAPI document and (b) recover the set of operationIds it
// declares, so a flow step's `operationId` can be validated even when the originating
// `.tsp` isn't present. Entity/endpoint detail comes from TypeSpec, not here.

import yaml from "js-yaml";

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

export interface OpenApiInfo {
  isOpenApi: boolean;
  /** operationId → "METHOD /path" summary, for display + validation. */
  operations: Map<string, string>;
  schemas: string[];
}

export function parseOpenApi(text: string): OpenApiInfo {
  const empty: OpenApiInfo = { isOpenApi: false, operations: new Map(), schemas: [] };
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch {
    return empty;
  }
  if (!doc || typeof doc !== "object") return empty;
  const d = doc as Record<string, any>;
  if (!d.openapi && !d.swagger) return empty;

  const operations = new Map<string, string>();
  const paths = (d.paths ?? {}) as Record<string, any>;
  for (const [route, item] of Object.entries(paths)) {
    if (!item || typeof item !== "object") continue;
    for (const method of HTTP_METHODS) {
      const op = (item as Record<string, any>)[method];
      if (op && typeof op === "object" && typeof op.operationId === "string") {
        operations.set(op.operationId, `${method.toUpperCase()} ${route}`);
      }
    }
  }
  const schemas = Object.keys(d.components?.schemas ?? {});
  return { isOpenApi: true, operations, schemas };
}
