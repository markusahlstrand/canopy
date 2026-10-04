import type { PluginEntry, PluginManifest, PluginSourceRef, ResolvedPlugin } from "@canopy/core";
import { strFromU8 } from "fflate";
import { unpackZip } from "./unpack-zip";

// Source paths are literal module identifiers. Do not normalize aliases that
// could select code outside the manifest's directory or collide with imports.
const plainPath = (path: string) => path.length > 0 && !path.includes("\\") &&
  !path.includes("\0") && !path.split("/").some(segment => !segment || segment === "." || segment === "..") &&
  !/^[a-zA-Z]:/.test(path);

const encodePath = (p: string) => p.split("/").filter(Boolean).map(encodeURIComponent).join("/");

async function fetchJson<T>(url: string, maxBytes?: number): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": "canopy" } });
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  if (maxBytes === undefined) return (await res.json()) as T;
  if (Number(res.headers.get("content-length")) > maxBytes) throw new Error("plugin manifest exceeds size limit");
  if (!res.body) throw new Error("plugin manifest has no body");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error("plugin manifest exceeds size limit"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as T;
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

async function githubCommit(ref: Extract<PluginSourceRef, { type: "github" }>, opts: ResolveOptions): Promise<string> {
  const gitRef = ref.ref || "main";
  ghBase(ref.repo, gitRef, ref.path ?? "");
  if (/^[a-f0-9]{40}$/i.test(gitRef)) return gitRef.toLowerCase();
  const url = `https://api.github.com/repos/${ref.repo}/commits/${encodeURIComponent(gitRef)}`;
  const headers: Record<string, string> = { "User-Agent": "canopy", Accept: "application/vnd.github.sha" };
  if (opts.githubToken) headers.Authorization = `Bearer ${opts.githubToken}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
      const reset = res.headers.get("x-ratelimit-reset");
      const delay = res.headers.get("retry-after");
      throw new Error(`GitHub rate limit reached (${res.status}); retry ${delay ? `after ${delay} seconds` : reset ? `after Unix time ${reset}` : "later"}`);
    }
    throw new Error(`fetch ${url} → ${res.status}`);
  }
  const commit = (await res.text()).trim();
  if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error("GitHub ref did not resolve to a commit SHA");
  return commit.toLowerCase();
}

async function resolveGithub(ref: Extract<PluginSourceRef, { type: "github" }>, opts: ResolveOptions): Promise<ResolvedPlugin> {
  const commit = await githubCommit(ref, opts);
  const { raw } = ghBase(ref.repo, commit, ref.path ?? "");
  const manifest = await fetchJson<PluginManifest>(raw("canopy.json"), 64 * 1024);
  const entry: PluginEntry = { url: raw(manifest.entry ?? "index.js") };
  return { manifest, entry, version: commit, source: ref, resolvedSource: { ...ref, ref: commit } };
}

// ── npm: registry version + package.json `canopy` manifest + esm.sh entry ─────

interface NpmMeta {
  "dist-tags": Record<string, string>;
  versions: Record<string, unknown>;
}

async function npmResolveVersion(name: string, version?: string, checkingUpdate = false): Promise<string> {
  // Names are URL path data, never query/fragment syntax or traversal segments.
  if (name.length > 214 || !/^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/.test(name)) {
    throw new Error(`Invalid npm package name: ${name}`);
  }
  const meta = await fetchJson<NpmMeta>(`https://registry.npmjs.org/${name}`);
  // Exact pins can discover newer latest releases. Tag installs stay on their
  // channel, so a prerelease install is not offered stable latest as a downgrade.
  const requested = checkingUpdate && version !== undefined && Object.hasOwn(meta.versions, version)
    ? "latest" : version ?? "latest";
  if (Object.hasOwn(meta.versions, requested)) return requested;
  const resolved = Object.hasOwn(meta["dist-tags"], requested) ? meta["dist-tags"][requested] : undefined;
  if (typeof resolved === "string" && Object.hasOwn(meta.versions, resolved)) return resolved;
  throw new Error(`${name}: npm version or tag "${requested}" is unavailable`);
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

export interface ZipLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}
/** Admission/allocation ceilings; callers may tighten these per import. */
export const DEFAULT_ZIP_LIMITS: Readonly<ZipLimits> = Object.freeze({
  maxArchiveBytes: 8 * 1024 * 1024, maxEntries: 256,
  maxEntryBytes: 4 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024,
});

function effectiveZipLimits(options: Partial<ZipLimits> = {}): ZipLimits {
  const limits = { ...DEFAULT_ZIP_LIMITS };
  for (const key of Object.keys(DEFAULT_ZIP_LIMITS) as (keyof ZipLimits)[]) {
    const value = options[key] ?? DEFAULT_ZIP_LIMITS[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_ZIP_LIMITS[key]) throw new Error(`invalid ZIP limit: ${key}`);
    limits[key] = value;
  }
  return limits;
}

export function resolveZipBytes(bytes: Uint8Array, source: PluginSourceRef, options: Partial<ZipLimits> = {}): ResolvedPlugin {
  const limits = effectiveZipLimits(options);
  if (bytes.byteLength > limits.maxArchiveBytes) throw new Error("zip exceeds archive byte limit");
  let totalBytes = 0;
  const seen = new Set<string>();
  const files = unpackZip(bytes, file => {
    if (seen.has(file.name)) throw new Error(`zip has duplicate entry: ${file.name}`);
    seen.add(file.name);
    if (seen.size > limits.maxEntries) throw new Error("zip exceeds entry count limit");
    // Bound declared output allocations and compressed processing before inflation.
    if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0 ||
        file.originalSize > limits.maxEntryBytes || file.size > limits.maxEntryBytes) throw new Error("zip exceeds entry byte limit");
    totalBytes += Math.max(file.originalSize, file.size);
    if (totalBytes > limits.maxTotalBytes) throw new Error("zip exceeds total byte limit");
    if (!plainPath(file.name.endsWith("/") ? file.name.slice(0, -1) : file.name)) throw new Error(`zip has an invalid path: ${file.name}`);
  });
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
  /** Used only for GitHub API lookups, never forwarded to raw URLs. */
  githubToken?: string;
  /** Required for zip refs. Enforce maxBytes while reading (size check or capped stream),
   * before buffering the whole object. Upload routes must enforce the same ceiling. */
  readZip?: (key: string, options: { maxBytes: number }) => Promise<Uint8Array>;
  zipLimits?: Partial<ZipLimits>;
}

export async function resolvePlugin(ref: PluginSourceRef, opts: ResolveOptions = {}): Promise<ResolvedPlugin> {
  switch (ref.type) {
    case "github":
      return resolveGithub(ref, opts);
    case "npm":
      return resolveNpm(ref);
    case "zip": {
      if (!opts.readZip) throw new Error("zip source requires a readZip provider");
      const limits = effectiveZipLimits(opts.zipLimits);
      return resolveZipBytes(await opts.readZip(ref.key, { maxBytes: limits.maxArchiveBytes }), ref, limits);
    }
  }
}

/** Returns the available update, or null if the installed version is current. */
export async function checkUpdate(
  ref: PluginSourceRef,
  installedVersion: string,
  opts: ResolveOptions = {},
): Promise<{ current: string; latest: string } | null> {
  let latest: string;
  if (ref.type === "npm") latest = await npmResolveVersion(ref.name, ref.version, true);
  else if (ref.type === "github") latest = await githubCommit(ref, opts);
  else return null; // zip: immutable upload, no remote to check
  return latest === installedVersion ? null : { current: installedVersion, latest };
}
