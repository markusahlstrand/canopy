// A focused, dependency-free TypeSpec (`.tsp`) reader. It recovers exactly what the
// project graph needs — models/enums (entities), operations (endpoints), the
// `operationId` each op maps to, and the model references that wire endpoints to
// entities — without pulling in `@typespec/compiler` (whose browser story requires
// a hand-built CompilerHost + a virtualised standard library; see the editor's
// design notes). It is intentionally tolerant: unknown constructs are skipped, not
// errored.
//
// Everything sits behind the async `compileTypeSpec()` boundary, so a real
// compiler-backed implementation can replace the body here with zero changes to the
// graph, linking, validation or UI layers.

import type { Diagnostic, SpecEndpoint, SpecField, SpecModel, SpecParam, SpecResponse, TextFile } from "./graph-types";

const SCALARS = new Set([
  "string", "boolean", "bytes", "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32",
  "uint64", "integer", "float", "float32", "float64", "decimal", "decimal128", "numeric", "safeint",
  "plainDate", "plainTime", "utcDateTime", "offsetDateTime", "duration", "url", "void", "never",
  "unknown", "null", "Record", "Array", "object", "true", "false",
]);

const VERBS = ["get", "post", "put", "patch", "delete", "head"] as const;
type Verb = (typeof VERBS)[number];

interface Deco {
  name: string;
  /** Raw argument text including the surrounding parens, e.g. `("listPets")`. */
  args: string;
}

interface Scope {
  ns: string;
  routePrefix: string;
}

const joinNs = (a: string, b: string) => (a ? `${a}.${b}` : b);

/** Pull the first string literal out of a decorator's raw args. */
function decoString(decos: Deco[], name: string): string | undefined {
  const d = decos.find((x) => x.name === name);
  if (!d) return undefined;
  const m = d.args.match(/"((?:[^"\\]|\\.)*)"/);
  if (!m) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}

const hasDeco = (decos: Deco[], name: string) => decos.some((d) => d.name === name);
const docOf = (decos: Deco[]) => decoString(decos, "__doc") ?? decoString(decos, "doc");

/** Every string literal in a decorator's raw args, in order. */
function decoStrings(args: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args))) {
    try {
      out.push(JSON.parse(`"${m[1]}"`));
    } catch {
      out.push(m[1]!);
    }
  }
  return out;
}

/**
 * Tags for filtering. We accept both the ergonomic `@tag("a", "b")` (repeatable) and
 * the standards-clean `@extension("x-tags", #["a", "b"])` vendor extension — the latter
 * is the only target-valid way to tag a *model* in the official compiler.
 */
function tagsOf(decos: Deco[]): string[] | undefined {
  const tags = new Set<string>();
  for (const d of decos) {
    if (d.name === "tag") for (const s of decoStrings(d.args)) tags.add(s);
    else if (d.name === "extension") {
      const strs = decoStrings(d.args);
      if (strs[0] === "x-tags") for (const s of strs.slice(1)) tags.add(s);
    }
  }
  return tags.size ? [...tags] : undefined;
}

/**
 * Replace comments with whitespace, but lift `/** … *\/` doc comments into a
 * synthetic `@__doc("…")` decorator on the following declaration so the UI can show
 * descriptions. String literals are respected so `//` inside a string survives.
 */
function preprocess(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const q = c;
      out += c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += src[i++];
      }
      out += src[i] ?? "";
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const isDoc = src[i + 2] === "*" && src[i + 3] !== "/";
      const end = src.indexOf("*/", i + 2);
      const body = src.slice(i + 2, end === -1 ? n : end);
      if (isDoc) {
        const text = body
          .replace(/^\*+/, "")
          .split("\n")
          .map((l) => l.replace(/^\s*\*?\s?/, ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        out += ` @__doc(${JSON.stringify(text)}) `;
      } else {
        out += " ";
      }
      i = end === -1 ? n : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** A cursor over preprocessed TypeSpec source. */
class Reader {
  i = 0;
  readonly s: string;
  constructor(s: string) {
    this.s = s;
  }
  get done() {
    return this.i >= this.s.length;
  }
  ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }
  peek() {
    return this.s[this.i];
  }
  ident(): string {
    this.ws();
    const m = /^[A-Za-z_$][A-Za-z0-9_$.]*/.exec(this.s.slice(this.i));
    if (!m) return "";
    this.i += m[0].length;
    return m[0];
  }
  /** Read a `(`/`[`/`{`/`<`-delimited span including the delimiters. */
  balanced(open: string, close: string): string {
    this.ws();
    if (this.s[this.i] !== open) return "";
    const start = this.i;
    let depth = 0;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === '"' || c === "'") {
        this.i++;
        while (this.i < this.s.length && this.s[this.i] !== c) {
          if (this.s[this.i] === "\\") this.i++;
          this.i++;
        }
      } else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          this.i++;
          break;
        }
      }
      this.i++;
    }
    return this.s.slice(start, this.i);
  }
  /** Consume up to (not past) any of `stops`, respecting nesting and strings. */
  until(stops: string[]): string {
    const start = this.i;
    let depth = 0;
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (c === '"' || c === "'") {
        this.i++;
        while (this.i < this.s.length && this.s[this.i] !== c) {
          if (this.s[this.i] === "\\") this.i++;
          this.i++;
        }
        this.i++;
        continue;
      }
      if (depth === 0 && stops.includes(c)) break;
      if ("([{<".includes(c)) depth++;
      else if (")]}>".includes(c)) depth--;
      this.i++;
    }
    return this.s.slice(start, this.i);
  }
  decorators(): Deco[] {
    const out: Deco[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] !== "@") break;
      this.i++;
      if (this.s[this.i] === "@") this.i++; // augment decorator `@@` — treat like a normal one
      const name = this.ident();
      let args = "";
      if (this.peek() === "(") args = this.balanced("(", ")");
      out.push({ name, args });
    }
    return out;
  }
}

/** Split a top-level list (params by `,`, responses by `|`) respecting nesting. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"' || c === "'") {
      cur += c;
      i++;
      while (i < s.length && s[i] !== c) {
        cur += s[i];
        i++;
      }
      cur += s[i] ?? "";
      continue;
    }
    if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c)) depth--;
    if (depth === 0 && c === sep) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const routeOf = (decos: Deco[]) => decoString(decos, "route") ?? "";
const verbOf = (decos: Deco[]): Verb | undefined => VERBS.find((v) => hasDeco(decos, v));
const isArray = (type: string) => /\[\s*\]\s*$/.test(type) || /^Array\s*</.test(type);

/** Identifiers in a type expression that could name a model, most-specific first. */
function typeIdents(type: string): string[] {
  // Drop string literals first so values like `"PUT"` in `method: "PUT"` (or string
  // unions like `"a" | "b"`) aren't mistaken for type references.
  const cleaned = type.replace(/"(?:[^"\\]|\\.)*"/g, "").replace(/'(?:[^'\\]|\\.)*'/g, "");
  const ids = cleaned.match(/[A-Za-z_$][A-Za-z0-9_$.]*/g) ?? [];
  return ids.filter((id) => !SCALARS.has(id) && !SCALARS.has(id.split(".").pop()!));
}

interface RawModel extends Omit<SpecModel, "fields"> {
  fields: SpecField[];
}

function parseModelBody(name: string, decos: Deco[], body: string, scope: Scope, file: string): RawModel {
  const r = new Reader(body.replace(/^\{/, "").replace(/\}$/, ""));
  const fields: SpecField[] = [];
  while (!r.done) {
    r.ws();
    if (r.done) break;
    const fdecos = r.decorators();
    r.ws();
    if (r.peek() === ".") {
      r.until([";"]);
      if (r.peek() === ";") r.i++;
      continue; // `...Spread` — skip
    }
    const fname = r.ident();
    if (!fname) {
      r.i++;
      continue;
    }
    r.ws();
    let optional = false;
    if (r.peek() === "?") {
      optional = true;
      r.i++;
    }
    r.ws();
    let type = "";
    if (r.peek() === ":") {
      r.i++;
      type = r.until([";", ","]).trim();
    }
    if (r.peek() === ";" || r.peek() === ",") r.i++;
    fields.push({
      name: fname,
      type: type || "unknown",
      optional,
      array: isArray(type),
      key: hasDeco(fdecos, "key") || hasDeco(fdecos, "id"),
      doc: docOf(fdecos),
    });
  }
  return {
    id: joinNs(scope.ns, name),
    name,
    namespace: scope.ns || undefined,
    kind: "model",
    doc: docOf(decos),
    isError: hasDeco(decos, "error"),
    tags: tagsOf(decos),
    fields,
    file,
  };
}

function parseEnumBody(name: string, decos: Deco[], body: string, scope: Scope, file: string): RawModel {
  const inner = body.replace(/^\{/, "").replace(/\}$/, "");
  const values = splitTop(inner, ",")
    .map((m) => m.trim().split(":")[0]!.trim().replace(/^@__doc\([^)]*\)/, "").trim())
    .filter(Boolean);
  return {
    id: joinNs(scope.ns, name),
    name,
    namespace: scope.ns || undefined,
    kind: "enum",
    doc: docOf(decos),
    tags: tagsOf(decos),
    fields: [],
    enumValues: values,
    file,
  };
}

function parseParams(str: string): SpecParam[] {
  const inner = str.replace(/^\(/, "").replace(/\)$/, "");
  if (!inner.trim()) return [];
  return splitTop(inner, ",").map((part) => {
    const r = new Reader(part);
    const decos = r.decorators();
    const pname = r.ident();
    r.ws();
    let optional = false;
    if (r.peek() === "?") {
      optional = true;
      r.i++;
    }
    r.ws();
    let type = "";
    if (r.peek() === ":") {
      r.i++;
      type = r.s.slice(r.i).trim();
    }
    const where = (["path", "query", "header", "body"] as const).find((w) => hasDeco(decos, w))
      ?? (hasDeco(decos, "bodyRoot") || hasDeco(decos, "bodyIgnore") ? "body" : undefined);
    return { name: pname, type: type || "string", optional, in: where } satisfies SpecParam;
  });
}

function parseResponses(ret: string): SpecResponse[] {
  if (!ret.trim()) return [];
  return splitTop(ret, "|")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ status: undefined, ref: undefined, _raw: p }) as SpecResponse & { _raw: string });
}

function makeEndpoint(
  opName: string,
  decos: Deco[],
  paramsStr: string,
  retStr: string,
  scope: Scope,
  routePrefix: string,
  group: string,
  file: string,
  inheritedTags?: string[],
): SpecEndpoint & { _retRaw: string } {
  const operationId = decoString(decos, "operationId") ?? opName;
  const route = (routePrefix + routeOf(decos)) || undefined;
  // Operation tags inherit from the enclosing interface/namespace (`@tag("pets")
  // interface Pets {…}`), as OpenAPI does, then add the op's own tags.
  const tagSet = new Set([...(inheritedTags ?? []), ...(tagsOf(decos) ?? [])]);
  return {
    id: operationId,
    operationId,
    name: opName,
    namespace: scope.ns || undefined,
    group: group || scope.ns || undefined,
    verb: verbOf(decos),
    route,
    doc: docOf(decos),
    parameters: parseParams(paramsStr),
    responses: parseResponses(retStr),
    refModels: [],
    tags: tagSet.size ? [...tagSet] : undefined,
    file,
    _retRaw: retStr,
  };
}

interface FileResult {
  models: RawModel[];
  endpoints: (SpecEndpoint & { _retRaw?: string })[];
  /**
   * Fully-qualified names of `alias`/`union` declarations. They aren't entities, but a
   * field/operation may reference one — so we record them to avoid flagging a valid
   * reference as a dangling (unknown) type.
   */
  typeNames: string[];
}

function parseInterfaceBody(decos: Deco[], body: string, ifaceName: string, scope: Scope, file: string): SpecEndpoint[] {
  const prefix = scope.routePrefix + routeOf(decos);
  const ifaceTags = tagsOf(decos);
  const r = new Reader(body.replace(/^\{/, "").replace(/\}$/, ""));
  const out: SpecEndpoint[] = [];
  while (!r.done) {
    r.ws();
    if (r.done) break;
    const odecos = r.decorators();
    r.ws();
    let kw = r.ident();
    if (kw === "op") {
      r.ws();
      kw = r.ident();
    }
    if (!kw) {
      r.i++;
      continue;
    }
    r.ws();
    const params = r.peek() === "(" ? r.balanced("(", ")") : "";
    r.ws();
    let ret = "";
    if (r.peek() === ":") {
      r.i++;
      ret = r.until([";"]).trim();
    }
    if (r.peek() === ";") r.i++;
    out.push(makeEndpoint(kw, odecos, params, ret, scope, prefix, ifaceName, file, ifaceTags));
  }
  return out;
}

function parseScope(src: string, scope: Scope, file: string, sink: FileResult): void {
  const r = new Reader(src);
  while (!r.done) {
    r.ws();
    if (r.done || r.peek() === "}") break;
    const decos = r.decorators();
    r.ws();
    const kw = r.ident();
    if (!kw) {
      r.i++;
      continue;
    }
    switch (kw) {
      case "import":
      case "using":
        r.until([";"]);
        if (r.peek() === ";") r.i++;
        break;
      case "namespace": {
        const name = r.ident();
        const inner: Scope = { ns: joinNs(scope.ns, name), routePrefix: scope.routePrefix + routeOf(decos) };
        r.ws();
        if (r.peek() === "{") {
          parseScope(r.balanced("{", "}"), inner, file, sink);
        } else {
          if (r.peek() === ";") r.i++;
          parseScope(r.s.slice(r.i), inner, file, sink); // file-scoped namespace: rest of file
          return;
        }
        break;
      }
      case "interface": {
        const name = r.ident();
        if (r.peek() === "<") r.balanced("<", ">");
        r.ws();
        const body = r.balanced("{", "}");
        sink.endpoints.push(...parseInterfaceBody(decos, body, name, scope, file));
        break;
      }
      case "op": {
        const name = r.ident();
        if (r.peek() === "<") r.balanced("<", ">");
        const params = r.peek() === "(" ? r.balanced("(", ")") : "";
        r.ws();
        let ret = "";
        if (r.peek() === ":") {
          r.i++;
          ret = r.until([";"]).trim();
        }
        if (r.peek() === ";") r.i++;
        sink.endpoints.push(makeEndpoint(name, decos, params, ret, scope, scope.routePrefix, scope.ns, file));
        break;
      }
      case "model": {
        const name = r.ident();
        if (r.peek() === "<") r.balanced("<", ">");
        r.ws();
        // `model X is Y;` / `model X extends Y { … }`
        if (r.peek() !== "{") r.until(["{", ";"]);
        if (r.peek() === "{") sink.models.push(parseModelBody(name, decos, r.balanced("{", "}"), scope, file));
        else if (r.peek() === ";") r.i++;
        break;
      }
      case "enum":
      case "union": {
        const name = r.ident();
        r.ws();
        const body = r.balanced("{", "}");
        if (kw === "enum") sink.models.push(parseEnumBody(name, decos, body, scope, file));
        else sink.typeNames.push(joinNs(scope.ns, name)); // named union — referenceable, not an entity
        break;
      }
      case "alias":
      case "scalar": {
        const name = r.ident();
        sink.typeNames.push(joinNs(scope.ns, name)); // referenceable, not an entity
        r.until(["{", ";"]);
        if (r.peek() === "{") r.balanced("{", "}");
        else if (r.peek() === ";") r.i++;
        break;
      }
      default:
        // const / unknown — skip a `{…}` block or to `;`
        r.until(["{", ";"]);
        if (r.peek() === "{") r.balanced("{", "}");
        else if (r.peek() === ";") r.i++;
        break;
    }
  }
}

/**
 * Parse a set of `.tsp` files into the contract layers of the project graph.
 * Async to match a future compiler-backed implementation.
 */
export async function compileTypeSpec(
  files: TextFile[],
): Promise<{ models: SpecModel[]; endpoints: SpecEndpoint[]; diagnostics: Diagnostic[] }> {
  const sink: FileResult = { models: [], endpoints: [], typeNames: [] };
  const diagnostics: Diagnostic[] = [];
  for (const f of files) {
    try {
      parseScope(preprocess(f.text), { ns: "", routePrefix: "" }, f.name, sink);
    } catch (e) {
      diagnostics.push({
        severity: "warning",
        layer: "tsp",
        message: `Couldn't fully parse ${f.name}: ${e instanceof Error ? e.message : "error"}`,
        file: f.name,
      });
    }
  }

  // Resolve model references now that every model name is known. Match the most
  // specific identifier in a type expression against simple + fully-qualified names.
  const byName = new Map<string, string>();
  for (const m of sink.models) {
    byName.set(m.id, m.id);
    // First-wins on the simple name: if two models in different namespaces share a
    // simple name (e.g. `A.Pet` and `B.Pet`), only the first one parsed is reachable
    // via the unqualified `Pet`. Fully-qualified ids above always disambiguate.
    if (!byName.has(m.name)) byName.set(m.name, m.id);
  }
  const errorModels = new Set(sink.models.filter((m) => m.isError).map((m) => m.id));
  const resolve = (type: string): string | undefined => {
    for (const id of typeIdents(type)) {
      const hit = byName.get(id) ?? byName.get(id.split(".").pop()!);
      if (hit) return hit;
    }
    return undefined;
  };
  // Names that are valid type references but not entities (aliases, named unions,
  // custom scalars). Referencing one is fine; it just produces no entity edge.
  const declaredTypes = new Set<string>();
  for (const id of sink.typeNames) {
    declaredTypes.add(id);
    declaredTypes.add(id.split(".").pop()!);
  }
  // A user-defined type (PascalCase) in a type expression that doesn't resolve to a
  // known model is a dangling reference — e.g. a model that was deleted/renamed.
  const danglingType = (type: string): string | undefined => {
    if (resolve(type)) return undefined;
    return typeIdents(type).find(
      (id) => /^[A-Z]/.test(id.split(".").pop()!) && !declaredTypes.has(id) && !declaredTypes.has(id.split(".").pop()!),
    );
  };

  const models: SpecModel[] = sink.models.map((m) => ({
    ...m,
    fields: m.fields.map((field) => {
      const ref = resolve(field.type);
      const dangling = ref ? undefined : danglingType(field.type);
      if (dangling) {
        diagnostics.push({
          severity: "error",
          layer: "tsp",
          message: `Model "${m.name}" field "${field.name}" references unknown type "${dangling}".`,
          target: { kind: "entity", id: m.id },
          file: m.file,
        });
      }
      return { ...field, ref };
    }),
  }));

  const endpoints: SpecEndpoint[] = sink.endpoints.map((ep) => {
    const refs = new Set<string>();
    const flagDangling = (type: string, where: string) => {
      const dangling = danglingType(type);
      if (dangling) {
        diagnostics.push({
          severity: "error",
          layer: "tsp",
          message: `Operation "${ep.operationId}" ${where} references unknown type "${dangling}".`,
          target: { kind: "endpoint", id: ep.operationId },
          file: ep.file,
        });
      }
    };
    const parameters = ep.parameters.map((p) => {
      const ref = resolve(p.type);
      if (ref) refs.add(ref);
      else flagDangling(p.type, `parameter "${p.name}"`);
      return { ...p, ref };
    });
    const raw = (ep as SpecEndpoint & { _retRaw?: string })._retRaw ?? "";
    const responses: SpecResponse[] = (splitTop(raw, "|").map((p) => p.trim()).filter(Boolean)).map((part) => {
      const ref = resolve(part);
      if (ref) refs.add(ref);
      else flagDangling(part, "response");
      const isErr = !!ref && errorModels.has(ref);
      return { status: isErr ? "default" : "200", ref, isError: isErr };
    });
    const { _retRaw, ...clean } = ep as SpecEndpoint & { _retRaw?: string };
    return { ...clean, parameters, responses, refModels: [...refs] };
  });

  return { models, endpoints, diagnostics };
}
