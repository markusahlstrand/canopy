// File discovery: from one opened `.tsp` or `.arazzo` file, gather the whole related
// set in the same folder so the project graph spans every layer. We scan the
// containing folder, classify by name, and read the relevant texts. Resolution of
// `sourceDescriptions` urls and `import`s happens in build-graph against this set.
//
// v1 scope: discovery stays within the opened file's folder. Cross-folder `import`
// targets and non-local source urls are surfaced as unresolved rather than chased.

import type { TextFile } from "./graph-types";
import { SIDECAR_NAME } from "./layout-sidecar";

export interface SpecFileRef {
  id: string;
  name: string;
  path: string;
}

/** Supplies the opened file's folder contents and reads file bodies on demand. */
export interface DiscoveryProvider {
  siblings: SpecFileRef[];
  readText(ref: SpecFileRef): Promise<string>;
}

export interface DiscoveredFiles {
  tsp: TextFile[];
  arazzo: TextFile[];
  openapi: TextFile[];
  asyncapi: TextFile[];
  /** The `canopy.layout.json` sidecar, when present in the folder. */
  layout?: TextFile;
}

export const isTsp = (name: string) => /\.tsp$/i.test(name);
export const isArazzo = (name: string) => /\.arazzo(\.(ya?ml|json))?$/i.test(name);
export const isAsyncApi = (name: string) => /\.asyncapi(\.(ya?ml|json))?$/i.test(name);
const isYamlOrJson = (name: string) => /\.(ya?ml|json)$/i.test(name);
const looksLikeOpenApi = (name: string) => /openapi|swagger/i.test(name);
const looksLikeAsyncApi = (name: string) => /asyncapi/i.test(name);
const sniffOpenApi = (text: string) => /^\s*("?(openapi|swagger)"?\s*:)/m.test(text);
const sniffAsyncApi = (text: string) => /^\s*("?asyncapi"?\s*:)/m.test(text);

const toTextFile = (ref: SpecFileRef, text: string): TextFile => ({ id: ref.id, name: ref.name, path: ref.path, text });

// Well-known JSON/YAML files that live next to specs but are never one. We skip them so
// opening a spec in a real project folder doesn't read (and sniff) the package manifest,
// tsconfig, lockfile, or tool rc files just to discard them. A real OpenAPI/AsyncAPI doc
// is never named any of these, and the layout sidecar is explicitly kept.
const NOISE_NAMES = new Set([
  "package.json", "package-lock.json", "components.json", "turbo.json", "nx.json", "vercel.json",
  "biome.json", "renovate.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "yarn.lock", "bun.lockb",
]);
const isNoiseFile = (name: string): boolean => {
  const lower = name.toLowerCase();
  if (lower === SIDECAR_NAME.toLowerCase()) return false; // the layout sidecar is wanted
  return (
    NOISE_NAMES.has(lower) ||
    /^[jt]sconfig(\.[^/]+)?\.json$/.test(lower) || // tsconfig.json, tsconfig.build.json, jsconfig.json
    /^\.[^/]+rc(\.(json|ya?ml))?$/.test(lower) || // .eslintrc, .prettierrc.json, .babelrc, …
    lower.endsWith(".tsbuildinfo")
  );
};

/**
 * Assemble the related file set for an opened spec file. The opened file's text is
 * passed in directly (it may hold unsaved edits) and overrides its drive copy.
 */
export async function discoverProject(
  opened: { id?: string; name: string; path?: string; text: string },
  provider: DiscoveryProvider,
): Promise<DiscoveredFiles> {
  const tsp = new Map<string, TextFile>();
  const arazzo = new Map<string, TextFile>();
  const openapi = new Map<string, TextFile>();
  const asyncapi = new Map<string, TextFile>();

  // Seed with the opened file so discovery works even before anything is read.
  if (isTsp(opened.name)) tsp.set(opened.name, { id: opened.id, name: opened.name, path: opened.path, text: opened.text });
  else if (isArazzo(opened.name)) arazzo.set(opened.name, { id: opened.id, name: opened.name, path: opened.path, text: opened.text });
  else if (isAsyncApi(opened.name)) asyncapi.set(opened.name, { id: opened.id, name: opened.name, path: opened.path, text: opened.text });

  const reads = provider.siblings
    .filter((ref) => isTsp(ref.name) || isArazzo(ref.name) || isAsyncApi(ref.name) || isYamlOrJson(ref.name))
    .filter((ref) => ref.name !== opened.name) // opened file already seeded
    .filter((ref) => !isNoiseFile(ref.name)) // skip package.json / tsconfig / lockfiles / rc files
    .map(async (ref) => {
      try {
        return { ref, text: await provider.readText(ref) };
      } catch {
        return null; // unreadable sibling — skip it, don't fail discovery
      }
    });

  let layout: TextFile | undefined;
  for (const result of await Promise.all(reads)) {
    if (!result) continue;
    const { ref, text } = result;
    if (ref.name === SIDECAR_NAME) layout = toTextFile(ref, text);
    else if (isTsp(ref.name)) tsp.set(ref.name, toTextFile(ref, text));
    else if (isArazzo(ref.name)) arazzo.set(ref.name, toTextFile(ref, text));
    // A bare `.asyncapi` file (or an `.asyncapi.{yaml,json}`); AsyncAPI is also
    // YAML/JSON, so sniff the YAML/JSON ones before falling through to OpenAPI.
    else if (isAsyncApi(ref.name) || (isYamlOrJson(ref.name) && (looksLikeAsyncApi(ref.name) || sniffAsyncApi(text)))) asyncapi.set(ref.name, toTextFile(ref, text));
    else if (isYamlOrJson(ref.name) && (looksLikeOpenApi(ref.name) || sniffOpenApi(text))) openapi.set(ref.name, toTextFile(ref, text));
  }

  return { tsp: [...tsp.values()], arazzo: [...arazzo.values()], openapi: [...openapi.values()], asyncapi: [...asyncapi.values()], layout };
}
