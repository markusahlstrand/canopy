import type { ProjectGraph, SelectionRef } from "./graph-types";
import type { RelatedSet, SpecIndex } from "./links";

/** Props every spec tab + the inspector share. */
export interface SpecViewProps {
  graph: ProjectGraph;
  index: SpecIndex;
  selection: SelectionRef | null;
  related: RelatedSet;
  /** Select an item — highlights it everywhere but stays on the current tab. */
  onSelect: (ref: SelectionRef | null) => void;
  /** Select an item and switch to the tab that owns it (cross-layer jump). */
  onNavigate: (ref: SelectionRef) => void;
}

export type SpecTab = "entities" | "endpoints" | "flows" | "source";

export const tabForKind = (kind: SelectionRef["kind"]): SpecTab =>
  kind === "entity" ? "entities" : kind === "endpoint" ? "endpoints" : "flows";

export const sameRef = (a: SelectionRef | null, b: SelectionRef | null): boolean =>
  !!a && !!b && a.kind === b.kind && a.id === b.id;
