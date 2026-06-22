// The unified, normalised "project graph" the spec editor projects onto its three
// tabs. The `.tsp` and `.arazzo` text files are the source of truth; this graph is
// rebuilt from them on open and on change. It is deliberately framework-agnostic
// (no React / React Flow types) so parsing, linking and validation can be unit
// tested in isolation and reused by a future write-back path.

/** A loaded text file (name + contents), the input to every parser here. */
export interface TextFile {
  /** File id in the drive, when discovered from a real folder (used to open it). */
  id?: string;
  /** Bare file name, e.g. `main.tsp`. */
  name: string;
  /** Folder-relative path used to resolve `import`/`url` references. */
  path?: string;
  text: string;
}

// ── Layer 1 + 2: the contract (TypeSpec models + operations) ──────────────────

export interface SpecField {
  name: string;
  /** Raw TypeSpec type expression, e.g. `string`, `Pet[]`, `Owner | Error`. */
  type: string;
  optional?: boolean;
  array?: boolean;
  /** `@key` — marks the entity's identity field. */
  key?: boolean;
  doc?: string;
  /** Name of a referenced model/enum when the field type points at one. */
  ref?: string;
}

export interface SpecModel {
  /** Stable id == fully-qualified name (`PetStore.Pet`). */
  id: string;
  name: string;
  namespace?: string;
  kind: "model" | "enum";
  /**
   * Whether the model is a persisted **entity** (has identity / lives beyond a single
   * request) or a transient **dto** — a request/response payload that only flows
   * through an operation. Derived, not declared: a model is an entity when it carries
   * `@key` or is reachable from a `@key`-bearing model through field references;
   * everything else is a wire shape. The ER view shows entities and renders DTOs
   * distinctly so the graph stays about real data relationships, not request envelopes.
   * Set during graph assembly; `undefined` only on graphs built before classification.
   */
  role?: "entity" | "dto";
  doc?: string;
  fields: SpecField[];
  /** Enum members when `kind === "enum"`. */
  enumValues?: string[];
  /** `@error`-decorated models render distinctly and are treated as error shapes. */
  isError?: boolean;
  /** Tags from `@tag("…")` or `@extension("x-tags", #[…])`, for view filtering. */
  tags?: string[];
  /** File the declaration came from. */
  file?: string;
}

export interface SpecParam {
  name: string;
  type: string;
  /** Where the parameter binds: path/query/header/body (from `@path` etc.). */
  in?: "path" | "query" | "header" | "body";
  optional?: boolean;
  /** Referenced model name, when the parameter type is one. */
  ref?: string;
}

export interface SpecResponse {
  /** HTTP status or `default`, when known. */
  status?: string;
  /** Referenced model name. */
  ref?: string;
  /** Whether the referenced model is an error shape. */
  isError?: boolean;
}

export interface SpecEndpoint {
  /** Stable id == the OpenAPI `operationId` the op maps to (Arazzo binds by this). */
  id: string;
  operationId: string;
  /** Source op name (may differ from operationId via `@operationId`). */
  name: string;
  namespace?: string;
  /** Grouping container (`interface`/`namespace`), for the list view. */
  group?: string;
  verb?: "get" | "post" | "put" | "patch" | "delete" | "head";
  route?: string;
  doc?: string;
  parameters: SpecParam[];
  responses: SpecResponse[];
  /** De-duplicated set of model names this op references (params + responses). */
  refModels: string[];
  /** Tags from `@tag("…")` (the OpenAPI-standard operation grouping). */
  tags?: string[];
  file?: string;
}

// ── Layer 3: workflows (Arazzo) ───────────────────────────────────────────────

/** A labelled control-flow edge out of a step (`onSuccess` / `onFailure`). */
export interface FlowBranch {
  on: "success" | "failure";
  type: "goto" | "end" | "retry";
  /** Target step id (for goto), within this workflow. */
  stepId?: string;
  /** Target workflow id (for goto across workflows). */
  workflowId?: string;
  /** Joined condition expressions, for the edge label. */
  criteria?: string;
}

export interface SpecStep {
  /** Stable id == `${workflowId}::${stepId}`. */
  id: string;
  stepId: string;
  workflowId: string;
  description?: string;
  /** The operation this step invokes (the link to an endpoint). */
  operationId?: string;
  operationPath?: string;
  /** A nested workflow this step runs instead of an operation. */
  callsWorkflowId?: string;
  /** Source description this step resolves its operation in (name). */
  sourceName?: string;
  outputs: string[];
  successCriteria: string[];
  branches: FlowBranch[];
  /** Ids (`${workflowId}::${stepId}`) of steps this one reads via `$steps.x`. */
  dependsOn: string[];
}

export interface SpecFlow {
  /** Stable id == workflowId. */
  id: string;
  workflowId: string;
  summary?: string;
  inputs: string[];
  outputs: string[];
  steps: SpecStep[];
  /** Tags from the workflow's `x-tags`/`tags` extension, for view filtering. */
  tags?: string[];
  file?: string;
}

export interface SpecSource {
  name: string;
  url: string;
  type?: string;
  /** Drive file id the url resolved to, when found in the folder. */
  resolvedFileId?: string;
  resolved: boolean;
}

// ── Layer 4: events (AsyncAPI) ────────────────────────────────────────────────
// The async counterpart to the HTTP contract: channels carry messages whose
// payloads are (often) the same models the REST endpoints use. We read structure
// only — channels, their send/receive operations, and message payload refs — and
// link payloads back to entities and (best-effort) channels back to endpoints.

export interface SpecMessage {
  /** Message key/name within the document. */
  name: string;
  title?: string;
  /** Referenced model name when the payload points at a named schema. */
  payloadRef?: string;
  /** Raw payload type when it isn't a named ref (inline object, primitive…). */
  payloadType?: string;
  contentType?: string;
  doc?: string;
}

/** One AsyncAPI operation — 3.x `send`/`receive`, or a normalised 2.x publish/subscribe. */
export interface SpecChannelOp {
  /** Operation id (3.x operations map key, or 2.x `operationId`). */
  id: string;
  /** Direction from the application's perspective (2.x subscribe⇒receive, publish⇒send). */
  action: "send" | "receive";
  doc?: string;
  /** Names of the messages this operation carries. */
  messages: string[];
}

export interface SpecChannel {
  /** Stable id == channel key (3.x) or channel name (2.x). */
  id: string;
  /** Display name — the channel key. */
  name: string;
  /** The channel address/topic/path (3.x `address`; 2.x falls back to the key). */
  address?: string;
  doc?: string;
  /** Protocols this channel binds to, resolved from its servers (e.g. `sse`, `ws`). */
  protocols?: string[];
  operations: SpecChannelOp[];
  messages: SpecMessage[];
  /** De-duplicated model names referenced by any message payload. */
  refModels: string[];
  /**
   * Explicit endpoint link hint from an `x-operationId` extension (channel or
   * operation level). Validated against the contract in build-graph.
   */
  operationIdHint?: string;
  /** Resolved endpoint id this channel links to (via {@link operationIdHint} or route match). */
  endpointId?: string;
  /** Tags from `tags: [{name}]`/`x-tags`, for view filtering. */
  tags?: string[];
  file?: string;
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

export type DiagnosticSeverity = "error" | "warning";
export type SpecLayer = "tsp" | "arazzo" | "openapi" | "asyncapi" | "link";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  layer: SpecLayer;
  message: string;
  /** What the diagnostic points at, so a click can select + reveal it. */
  target?: SelectionRef;
  file?: string;
}

// ── The graph + selection ─────────────────────────────────────────────────────

export type SelectionKind = "entity" | "endpoint" | "flow" | "step" | "channel";

export interface SelectionRef {
  kind: SelectionKind;
  /** The stable id of the referenced model/endpoint/flow/step. */
  id: string;
}

/** A discovered file kept with its raw text, for the Source tab. */
export interface SourceFile {
  id?: string;
  name: string;
  kind: "tsp" | "openapi" | "arazzo" | "asyncapi";
  text: string;
}

// ── Layout sidecar (canopy.layout.json) ───────────────────────────────────────
// Saved entity arrangements. The `.tsp` stays the source of truth for the model;
// this only remembers positions. One file can hold several named views.

export interface LayoutView {
  id: string;
  name: string;
  /** model id → position. Missing entities fall back to auto-layout. */
  entities: Record<string, { x: number; y: number }>;
  /** step id (`${workflowId}::${stepId}`) → position. Missing steps auto-layout. */
  steps: Record<string, { x: number; y: number }>;
  /**
   * Active tag filter for this view: an OR include-list. Empty ⇒ show everything;
   * otherwise only entities/flows carrying at least one of these tags are shown.
   */
  tagFilter: string[];
}

export interface LayoutSidecar {
  version: number;
  views: LayoutView[];
}

export interface ProjectGraph {
  models: SpecModel[];
  endpoints: SpecEndpoint[];
  flows: SpecFlow[];
  /** Event-driven channels (AsyncAPI), the async projection of the contract. */
  channels: SpecChannel[];
  sources: SpecSource[];
  diagnostics: Diagnostic[];
  /** Names of the files that fed the graph, grouped by kind (for the header). */
  files: { tsp: string[]; openapi: string[]; arazzo: string[]; asyncapi: string[] };
  /** Every discovered file with its raw text — the canonical source of truth. */
  sourceFiles: SourceFile[];
  /** Committed entity layout (from `canopy.layout.json`), with its named views. */
  layout: LayoutSidecar;
  /** Drive id of the layout sidecar, when one exists (for write-back). */
  layoutFileId?: string;
  /** True when no contract/workflow content was found at all. */
  empty: boolean;
}

export const emptyGraph = (): ProjectGraph => ({
  models: [],
  endpoints: [],
  flows: [],
  channels: [],
  sources: [],
  diagnostics: [],
  files: { tsp: [], openapi: [], arazzo: [], asyncapi: [] },
  sourceFiles: [],
  layout: { version: 1, views: [{ id: "default", name: "Default", entities: {}, steps: {}, tagFilter: [] }] },
  empty: true,
});
