// Parse an Arazzo workflow document (YAML/JSON) into the flow layer of the project
// graph. We read structure only — we never execute a workflow. Data dependencies
// between steps (`$steps.x.outputs…`) become DAG edges; `onSuccess`/`onFailure`
// become labelled control-flow branches.

import yaml from "js-yaml";
import type { Diagnostic, FlowBranch, SpecFlow, SpecSource, SpecStep } from "./graph-types";

export interface ArazzoResult {
  isArazzo: boolean;
  flows: SpecFlow[];
  sources: SpecSource[];
  /** `x-typespec-source` extension: explicit link to the originating `.tsp`. */
  typespecSource?: string;
  diagnostics: Diagnostic[];
}

const empty: ArazzoResult = { isArazzo: false, flows: [], sources: [], diagnostics: [] };

const keysOf = (v: unknown): string[] => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : []);

/** Collect the step ids referenced by `$steps.<id>.…` anywhere in a value. */
function referencedStepIds(value: unknown): string[] {
  const text = JSON.stringify(value ?? "");
  const out = new Set<string>();
  const re = /\$steps\.([A-Za-z0-9_$-]+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.add(m[1]!);
  return [...out];
}

function readCriteria(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((c) => (typeof c === "string" ? c : c && typeof c === "object" ? (c as any).condition : undefined))
    .filter((c): c is string => typeof c === "string");
}

function readBranches(on: "success" | "failure", value: unknown): FlowBranch[] {
  if (!Array.isArray(value)) return [];
  return value.map((b) => {
    const o = (b ?? {}) as Record<string, any>;
    const criteria = readCriteria(o.criteria);
    return {
      on,
      type: o.type === "end" ? "end" : o.type === "retry" ? "retry" : "goto",
      stepId: typeof o.stepId === "string" ? o.stepId : undefined,
      workflowId: typeof o.workflowId === "string" ? o.workflowId : undefined,
      criteria: criteria.length ? criteria.join(" && ") : undefined,
    } satisfies FlowBranch;
  });
}

export function parseArazzo(text: string, fileName: string): ArazzoResult {
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch (e) {
    return { ...empty, diagnostics: [{ severity: "error", layer: "arazzo", message: `Invalid YAML in ${fileName}: ${e instanceof Error ? e.message : "parse error"}`, file: fileName }] };
  }
  if (!doc || typeof doc !== "object" || !("arazzo" in (doc as object))) return empty;
  const d = doc as Record<string, any>;
  const diagnostics: Diagnostic[] = [];

  const sources: SpecSource[] = (Array.isArray(d.sourceDescriptions) ? d.sourceDescriptions : []).map((s: any) => ({
    name: String(s?.name ?? ""),
    url: String(s?.url ?? ""),
    type: typeof s?.type === "string" ? s.type : undefined,
    resolved: false,
  }));
  const defaultSource = sources.length === 1 ? sources[0]!.name : undefined;

  const flows: SpecFlow[] = (Array.isArray(d.workflows) ? d.workflows : []).map((w: any) => {
    const workflowId = String(w?.workflowId ?? "workflow");
    const rawSteps: any[] = Array.isArray(w?.steps) ? w.steps : [];
    const stepIds = new Set(rawSteps.map((s) => String(s?.stepId ?? "")));

    const steps: SpecStep[] = rawSteps.map((s) => {
      const stepId = String(s?.stepId ?? "step");
      const refs = referencedStepIds(s).filter((id) => id !== stepId);
      for (const ref of refs) {
        if (!stepIds.has(ref)) {
          diagnostics.push({
            severity: "warning",
            layer: "arazzo",
            message: `Step "${stepId}" references $steps.${ref}, which doesn't exist in workflow "${workflowId}".`,
            target: { kind: "step", id: `${workflowId}::${stepId}` },
            file: fileName,
          });
        }
      }
      return {
        id: `${workflowId}::${stepId}`,
        stepId,
        workflowId,
        description: typeof s?.description === "string" ? s.description : undefined,
        operationId: typeof s?.operationId === "string" ? s.operationId : undefined,
        operationPath: typeof s?.operationPath === "string" ? s.operationPath : undefined,
        callsWorkflowId: typeof s?.workflowId === "string" ? s.workflowId : undefined,
        sourceName: typeof s?.["x-source"] === "string" ? s["x-source"] : defaultSource,
        outputs: keysOf(s?.outputs),
        successCriteria: readCriteria(s?.successCriteria),
        branches: [...readBranches("success", s?.onSuccess), ...readBranches("failure", s?.onFailure)],
        dependsOn: refs.filter((id) => stepIds.has(id)).map((id) => `${workflowId}::${id}`),
      } satisfies SpecStep;
    });

    return {
      id: workflowId,
      workflowId,
      summary: typeof w?.summary === "string" ? w.summary : typeof w?.description === "string" ? w.description : undefined,
      inputs: keysOf(w?.inputs?.properties) ,
      outputs: keysOf(w?.outputs),
      steps,
      file: fileName,
    } satisfies SpecFlow;
  });

  return {
    isArazzo: true,
    flows,
    sources,
    typespecSource: typeof d["x-typespec-source"] === "string" ? d["x-typespec-source"] : undefined,
    diagnostics,
  };
}
