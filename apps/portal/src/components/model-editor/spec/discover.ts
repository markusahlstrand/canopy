// File discovery: from one opened `.tsp` or `.arazzo` file, gather the whole related
// set in the same folder so the project graph spans all three layers. We scan the
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
  /** The `canopy.layout.json` sidecar, when present in the folder. */
  layout?: TextFile;
}

export const isTsp = (name: string) => /\.tsp$/i.test(name);
export const isArazzo = (name: string) => /\.arazzo(\.(ya?ml|json))?$/i.test(name);
const isYamlOrJson = (name: string) => /\.(ya?ml|json)$/i.test(name);
const looksLikeOpenApi = (name: string) => /openapi|swagger/i.test(name);
const sniffOpenApi = (text: string) => /^\s*("?(openapi|swagger)"?\s*:)/m.test(text);

const toTextFile = (ref: SpecFileRef, text: string): TextFile => ({ id: ref.id, name: ref.name, path: ref.path, text });

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

  // Seed with the opened file so discovery works even before anything is read.
  if (isTsp(opened.name)) tsp.set(opened.name, { id: opened.id, name: opened.name, path: opened.path, text: opened.text });
  else if (isArazzo(opened.name)) arazzo.set(opened.name, { id: opened.id, name: opened.name, path: opened.path, text: opened.text });

  const reads = provider.siblings
    .filter((ref) => isTsp(ref.name) || isArazzo(ref.name) || isYamlOrJson(ref.name))
    .filter((ref) => ref.name !== opened.name) // opened file already seeded
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
    else if (isYamlOrJson(ref.name) && (looksLikeOpenApi(ref.name) || sniffOpenApi(text))) openapi.set(ref.name, toTextFile(ref, text));
  }

  return { tsp: [...tsp.values()], arazzo: [...arazzo.values()], openapi: [...openapi.values()], layout };
}
