// The cross-reference index — the heart of the feature. It turns the flat graph into
// typed adjacency (endpoint↔entity, step→endpoint, flow→step) and answers the two
// questions the UI asks constantly: "what does this select?" (selection-follows) and
// "what uses this?" (find-usages), in both directions across all three layers.

import type { ProjectGraph, SelectionRef, SpecEndpoint, SpecFlow, SpecModel, SpecStep } from "./graph-types";

/** Ids of related items per layer, used to highlight across tabs. */
export interface RelatedSet {
  entities: Set<string>;
  endpoints: Set<string>;
  steps: Set<string>;
  flows: Set<string>;
}

const emptyRelated = (): RelatedSet => ({
  entities: new Set(),
  endpoints: new Set(),
  steps: new Set(),
  flows: new Set(),
});

export class SpecIndex {
  readonly modelById = new Map<string, SpecModel>();
  readonly endpointById = new Map<string, SpecEndpoint>();
  readonly flowById = new Map<string, SpecFlow>();
  readonly stepById = new Map<string, SpecStep>();

  /** operationId → endpoint (== endpoint.id, kept explicit for clarity). */
  private readonly endpointByOp = new Map<string, SpecEndpoint>();
  /** model id → endpoints that reference it. */
  private readonly endpointsForModel = new Map<string, Set<string>>();
  /** endpoint id → steps that bind to it. */
  private readonly stepsForEndpoint = new Map<string, Set<string>>();
  /** step id → its flow id. */
  private readonly flowForStep = new Map<string, string>();

  readonly graph: ProjectGraph;

  constructor(graph: ProjectGraph) {
    this.graph = graph;
    for (const m of graph.models) this.modelById.set(m.id, m);
    for (const e of graph.endpoints) {
      this.endpointById.set(e.id, e);
      this.endpointByOp.set(e.operationId, e);
      for (const ref of e.refModels) {
        if (!this.endpointsForModel.has(ref)) this.endpointsForModel.set(ref, new Set());
        this.endpointsForModel.get(ref)!.add(e.id);
      }
    }
    for (const f of graph.flows) {
      this.flowById.set(f.id, f);
      for (const s of f.steps) {
        this.stepById.set(s.id, s);
        this.flowForStep.set(s.id, f.id);
        const ep = s.operationId ? this.endpointByOp.get(s.operationId) : undefined;
        if (ep) {
          if (!this.stepsForEndpoint.has(ep.id)) this.stepsForEndpoint.set(ep.id, new Set());
          this.stepsForEndpoint.get(ep.id)!.add(s.id);
        }
      }
    }
  }

  endpointForStep(step: SpecStep): SpecEndpoint | undefined {
    return step.operationId ? this.endpointByOp.get(step.operationId) : undefined;
  }

  /** Endpoints that reference a given model id. */
  endpointsUsingModel(modelId: string): SpecEndpoint[] {
    return [...(this.endpointsForModel.get(modelId) ?? [])].map((id) => this.endpointById.get(id)!).filter(Boolean);
  }

  /** Steps (and their flows) that call a given endpoint id. */
  stepsCallingEndpoint(endpointId: string): SpecStep[] {
    return [...(this.stepsForEndpoint.get(endpointId) ?? [])].map((id) => this.stepById.get(id)!).filter(Boolean);
  }

  flowsCallingEndpoint(endpointId: string): SpecFlow[] {
    const flows = new Set<string>();
    for (const s of this.stepsCallingEndpoint(endpointId)) flows.add(this.flowForStep.get(s.id)!);
    return [...flows].map((id) => this.flowById.get(id)!).filter(Boolean);
  }

  /** Models an endpoint touches, in declaration order. */
  modelsForEndpoint(endpointId: string): SpecModel[] {
    const e = this.endpointById.get(endpointId);
    if (!e) return [];
    return e.refModels.map((id) => this.modelById.get(id)!).filter(Boolean);
  }

  /** Flows that transitively reach a model (via any endpoint that references it). */
  flowsReachingModel(modelId: string): SpecFlow[] {
    const flows = new Set<string>();
    for (const e of this.endpointsUsingModel(modelId)) for (const f of this.flowsCallingEndpoint(e.id)) flows.add(f.id);
    return [...flows].map((id) => this.flowById.get(id)!).filter(Boolean);
  }

  /**
   * Everything related to the current selection, for cross-tab highlighting. Always
   * includes the selected item itself so it reads as "active" in its own tab.
   */
  related(selection: SelectionRef | null): RelatedSet {
    const r = emptyRelated();
    if (!selection) return r;
    const addEndpoint = (id: string) => {
      r.endpoints.add(id);
      for (const m of this.modelsForEndpoint(id)) r.entities.add(m.id);
      for (const s of this.stepsCallingEndpoint(id)) {
        r.steps.add(s.id);
        r.flows.add(this.flowForStep.get(s.id)!);
      }
    };

    switch (selection.kind) {
      case "entity": {
        const m = this.modelById.get(selection.id);
        if (!m) return r;
        r.entities.add(m.id);
        for (const f of m.fields) if (f.ref) r.entities.add(f.ref); // models it references
        for (const e of this.endpointsUsingModel(m.id)) addEndpoint(e.id);
        for (const f of this.flowsReachingModel(m.id)) r.flows.add(f.id);
        break;
      }
      case "endpoint":
        addEndpoint(selection.id);
        break;
      case "flow": {
        const f = this.flowById.get(selection.id);
        if (!f) return r;
        r.flows.add(f.id);
        for (const s of f.steps) {
          r.steps.add(s.id);
          const ep = this.endpointForStep(s);
          if (ep) addEndpoint(ep.id);
        }
        break;
      }
      case "step": {
        const s = this.stepById.get(selection.id);
        if (!s) return r;
        r.steps.add(s.id);
        r.flows.add(this.flowForStep.get(s.id)!);
        const ep = this.endpointForStep(s);
        if (ep) addEndpoint(ep.id);
        break;
      }
    }
    return r;
  }
}
