import type { PluginEntry, PluginManifest, PluginSourceRef, ResolvedPlugin } from "@canopy/core";
import { unzipSync, strFromU8 } from "fflate";

// Source paths are literal module identifiers. Do not normalize aliases that
// could select code outside the manifest's directory or collide with imports.
const plainPath = (path: string) => path.length > 0 && !path.includes("\\") &&
  !path.includes("\0") && !path.split("/").some(segment => !segment || segment === "." || segment === "..") &&
  !/^[a-zA-Z]:/.test(path);

const encodePath = (p: string) => p.split("/").filter(Boolean).map(encodeURIComponent).join("/");

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": "canopy" } });
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return (await res.json()) as T;
}

// ── GitHub: repo folder with a canopy.json + entry module (public repos) ──────

function ghBase(repo: string, ref: string, path: string) {
  const [owner, name] = repo.split("/");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(repo) || !plainPath(repo)) throw new Error("invalid GitHub repository");
  if (!plainPath(ref)) throw new Error("invalid GitHub ref");
  if (path && !plainPath(path)) throw new Error("invalid GitHub plugin path");
  const dir = path;
  const raw = (file: string) => {
    if (typeof file !== "string" || !plainPath(file)) throw new Error("GitHub entry must be a plain relative file path");
    return `https://raw.githubusercontent.com/${owner}/${name}/${encodeURIComponent(ref)}/${encodePath([dir, file].filter(Boolean).join("/"))}`;
  };
  return { raw };
}

async function resolveGithub(ref: Extract<PluginSourceRef, { type: "github" }>): Promise<ResolvedPlugin> {
  const gitRef = ref.ref || "main";
  const { raw } = ghBase(ref.repo, gitRef, ref.path ?? "");
  const manifest = await fetchJson<PluginManifest>(raw("canopy.json"));
  const entry: PluginEntry = { url: raw(manifest.entry ?? "index.js") };
  return { manifest, entry, version: manifest.version, source: ref };
}

// ── npm: registry version + package.json `canopy` manifest + esm.sh entry ─────

interface NpmMeta {
  "dist-tags": Record<string, string>;
  versions: Record<string, unknown>;
}

async function npmResolveVersion(name: string, version?: string): Promise<string> {
  const meta = await fetchJson<NpmMeta>(`https://registry.npmjs.org/${name}`);
  if (version && meta.versions[version]) return version;
  return meta["dist-tags"][version ?? "latest"] ?? meta["dist-tags"].latest!;
}

async function resolveNpm(ref: Extract<PluginSourceRef, { type: "npm" }>): Promise<ResolvedPlugin> {
  const version = await npmResolveVersion(ref.name, ref.version);
  const pkg = await fetchJson<{ canopy?: PluginManifest }>(
    `https://cdn.jsdelivr.net/npm/${ref.name}@${version}/package.json`,
  );
  if (!pkg.canopy) throw new Error(`${ref.name}@${version} has no "canopy" manifest in package.json`);
  const manifest: PluginManifest = { ...pkg.canopy, version };
  // esm.sh serves the package as ESM (deps bundled) — loadable by URL.
  const entry: PluginEntry = { url: `https://esm.sh/${ref.name}@${version}` };
  return { manifest, entry, version, source: ref };
}

// ── zip: unpacked archive (manifest + inline code) ────────────────────────────

export function resolveZipBytes(bytes: Uint8Array, source: PluginSourceRef): ResolvedPlugin {
  const seen = new Set<string>();
  const files = unzipSync(bytes, { filter: file => {
    if (seen.has(file.name)) throw new Error(`zip has duplicate entry: ${file.name}`);
    seen.add(file.name);
    if (!plainPath(file.name.endsWith("/") ? file.name.slice(0, -1) : file.name)) throw new Error(`zip has an invalid path: ${file.name}`);
    return true;
  } });
  const keys = Object.keys(files);
  const manifests = keys.filter(key => key === "canopy.json" || key.endsWith("/canopy.json"));
  if (!manifests.length) throw new Error("zip has no canopy.json");
  if (manifests.length !== 1) throw new Error("zip has multiple canopy.json manifests");
  const manifestKey = manifests[0]!;
  const baseDir = manifestKey.slice(0, manifestKey.length - "canopy.json".length);
  const manifest = JSON.parse(strFromU8(files[manifestKey]!)) as PluginManifest;

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("zip manifest must be an object");
  const entryPath = manifest.entry ?? "index.js";
  if (typeof entryPath !== "string" || !plainPath(entryPath) || entryPath.endsWith("/")) {
    throw new Error("zip entry must be a plain relative file path");
  }
  const entryKey = baseDir + entryPath;
  const entryBytes = Object.hasOwn(files, entryKey) ? files[entryKey] : undefined;
  if (!entryBytes) throw new Error(`zip missing entry "${manifest.entry ?? "index.js"}"`);

  const modules: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) {
    if (k !== entryKey && k.startsWith(baseDir) && k.endsWith(".js")) modules[k.slice(baseDir.length)] = strFromU8(v);
  }
  const entry: PluginEntry = { code: strFromU8(entryBytes), modules: Object.keys(modules).length ? modules : undefined };
  return { manifest, entry, version: manifest.version, source };
}

// ── unified API ───────────────────────────────────────────────────────────────

export interface ResolveOptions {
  /** Required for zip refs: returns the raw archive bytes for a storage key. */
  readZip?: (key: string) => Promise<Uint8Array>;
}

export async function resolvePlugin(ref: PluginSourceRef, opts: ResolveOptions = {}): Promise<ResolvedPlugin> {
  switch (ref.type) {
    case "github":
      return resolveGithub(ref);
    case "npm":
      return resolveNpm(ref);
    case "zip": {
      if (!opts.readZip) throw new Error("zip source requires a readZip provider");
      return resolveZipBytes(await opts.readZip(ref.key), ref);
    }
  }
}

/** Returns the available update, or null if the installed version is current. */
export async function checkUpdate(
  ref: PluginSourceRef,
  installedVersion: string,
): Promise<{ current: string; latest: string } | null> {
  let latest: string;
  if (ref.type === "npm") latest = await npmResolveVersion(ref.name);
  else if (ref.type === "github") latest = (await resolveGithub(ref)).version;
  else return null; // zip: immutable upload, no remote to check
  return latest === installedVersion ? null : { current: installedVersion, latest };
}
