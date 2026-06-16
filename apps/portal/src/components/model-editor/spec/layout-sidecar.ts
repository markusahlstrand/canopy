// Read/write the `canopy.layout.json` sidecar — named entity arrangements ("views").
// Tolerant of older/simpler shapes so a hand-written or earlier file still loads.

import { uid } from "../types";
import type { LayoutSidecar, LayoutView } from "./graph-types";

export const SIDECAR_NAME = "canopy.layout.json";

const isPos = (v: unknown): v is { x: number; y: number } =>
  !!v && typeof v === "object" && typeof (v as any).x === "number" && typeof (v as any).y === "number";

function coerceEntities(raw: unknown): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) if (isPos(v)) out[k] = { x: v.x, y: v.y };
  return out;
}

export function emptySidecar(): LayoutSidecar {
  return { version: 1, views: [{ id: "default", name: "Default", entities: {} }] };
}

/** Parse sidecar JSON, migrating a bare positions map or single-view shape to views[]. */
export function parseSidecar(text: string): LayoutSidecar {
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    return emptySidecar();
  }
  if (!doc || typeof doc !== "object") return emptySidecar();

  // Current shape: { version, views: [{ id, name, entities }] }
  if (Array.isArray(doc.views) && doc.views.length) {
    const views: LayoutView[] = doc.views.map((v: any, i: number) => ({
      id: typeof v?.id === "string" ? v.id : uid("view"),
      name: typeof v?.name === "string" && v.name.trim() ? v.name : `View ${i + 1}`,
      entities: coerceEntities(v?.entities),
    }));
    return { version: 1, views };
  }
  // Single-view: { entities: {...} }
  if (doc.entities) return { version: 1, views: [{ id: "default", name: "Default", entities: coerceEntities(doc.entities) }] };
  // Flat map: { "Model.Id": {x,y}, ... }
  const flat = coerceEntities(doc);
  if (Object.keys(flat).length) return { version: 1, views: [{ id: "default", name: "Default", entities: flat }] };
  return emptySidecar();
}

export function serializeSidecar(sidecar: LayoutSidecar): string {
  return JSON.stringify(sidecar, null, 2) + "\n";
}

export const newView = (name: string): LayoutView => ({ id: uid("view"), name, entities: {} });
