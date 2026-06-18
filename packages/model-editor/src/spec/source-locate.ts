// Find the 1-based source line where a graph item is declared, by searching the raw
// file text. The TypeSpec parser works over a preprocessed copy (comments stripped,
// doc comments lifted), so offsets there don't map back to the original — searching
// the untouched text is both simpler and accurate enough to anchor a "View source"
// jump.

import type { ProjectGraph, SelectionRef, SpecEndpoint, SpecFlow, SpecModel, SpecStep } from "./graph-types";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

function firstLine(text: string, ...patterns: RegExp[]): number | undefined {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return lineOf(text, m.index);
  }
  return undefined;
}

const locateModel = (text: string, m: SpecModel) =>
  firstLine(text, new RegExp(`\\b(?:model|enum|union)\\s+${esc(m.name)}\\b`));

const locateEndpoint = (text: string, e: SpecEndpoint) =>
  firstLine(
    text,
    // Explicit @operationId is the most precise anchor; else the op declaration.
    e.operationId !== e.name ? new RegExp(`@operationId\\s*\\(\\s*["']${esc(e.operationId)}["']`) : new RegExp("$^"),
    new RegExp(`\\b(?:op\\s+)?${esc(e.name)}\\s*[(<]`),
  );

const locateFlow = (text: string, f: SpecFlow) => firstLine(text, new RegExp(`\\bworkflowId\\s*:\\s*["']?${esc(f.workflowId)}\\b`));
const locateStep = (text: string, s: SpecStep) => firstLine(text, new RegExp(`\\bstepId\\s*:\\s*["']?${esc(s.stepId)}\\b`));

export interface SourceLocation {
  file: string;
  line?: number;
}

/** Resolve the file + line for a selected item, for the inspector's "View source" link. */
export function locate(graph: ProjectGraph, ref: SelectionRef): SourceLocation | undefined {
  const textOf = (name?: string) => (name ? graph.sourceFiles.find((f) => f.name === name)?.text : undefined);

  if (ref.kind === "entity") {
    const m = graph.models.find((x) => x.id === ref.id);
    const text = textOf(m?.file);
    if (!m?.file || !text) return undefined;
    return { file: m.file, line: locateModel(text, m) };
  }
  if (ref.kind === "endpoint") {
    const e = graph.endpoints.find((x) => x.id === ref.id);
    const text = textOf(e?.file);
    if (!e?.file || !text) return undefined;
    return { file: e.file, line: locateEndpoint(text, e) };
  }
  if (ref.kind === "flow") {
    const f = graph.flows.find((x) => x.id === ref.id);
    const text = textOf(f?.file);
    if (!f?.file || !text) return undefined;
    return { file: f.file, line: locateFlow(text, f) };
  }
  // step — its source line lives in the flow's Arazzo file
  const step = graph.flows.flatMap((f) => f.steps).find((s) => s.id === ref.id);
  const file = graph.flows.find((f) => f.id === step?.workflowId)?.file;
  const text = textOf(file);
  if (!step || !file || !text) return undefined;
  return { file, line: locateStep(text, step) };
}
