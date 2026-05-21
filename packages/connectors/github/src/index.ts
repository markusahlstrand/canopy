import type { Page, StorageConnector, StorageEntry } from "@canopy/core";

export interface GithubConnectorConfig {
  owner: string;
  repo: string;
  /** Default "main". */
  branch?: string;
  /** Repo subdirectory this connector is rooted at, e.g. "docs". */
  basePath?: string;
  /** Optional token for higher rate limits / private repos. */
  token?: string;
}

interface GhContentItem {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  size: number;
}

function encodePath(p: string): string {
  return p
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

/**
 * Read-only connector over a GitHub repository (Contents API). Lets the demo
 * drive and the docs mount be read live from GitHub instead of being bundled
 * into the deployment. Writes are rejected.
 */
export function createGithubConnector(id: string, config: GithubConnectorConfig): StorageConnector {
  const branch = config.branch || "main";
  const base = (config.basePath ?? "").replace(/^\/+|\/+$/g, "");
  const apiHeaders: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "canopy",
  };
  if (config.token) apiHeaders.Authorization = `Bearer ${config.token}`;

  const repoPath = (p?: string): string => [base, (p ?? "").replace(/^\/+|\/+$/g, "")].filter(Boolean).join("/");
  const toRelative = (full: string): string => {
    const pfx = base ? `${base}/` : "";
    return full.startsWith(pfx) ? full.slice(pfx.length) : full;
  };

  async function contents(p: string, accept = "application/vnd.github+json"): Promise<Response> {
    const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${encodePath(p)}?ref=${branch}`;
    return fetch(url, { headers: { ...apiHeaders, Accept: accept } });
  }

  return {
    id,

    async list(path): Promise<Page<StorageEntry>> {
      const res = await contents(repoPath(path));
      if (res.status === 404) return { items: [] };
      if (!res.ok) throw new Error(`github list failed: ${res.status}`);
      const data = (await res.json()) as GhContentItem | GhContentItem[];
      const arr = Array.isArray(data) ? data : [data];
      const items: StorageEntry[] = arr.map((it) => ({
        path: toRelative(it.path),
        name: it.name,
        kind: it.type === "dir" ? "folder" : "file",
        size: it.type === "dir" ? undefined : it.size,
      }));
      items.sort((a, b) => (a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : a.name.localeCompare(b.name)));
      return { items };
    },

    async stat(path): Promise<StorageEntry | null> {
      const res = await contents(repoPath(path));
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`github stat failed: ${res.status}`);
      const data = (await res.json()) as GhContentItem | GhContentItem[];
      if (Array.isArray(data)) {
        const name = path.split("/").filter(Boolean).pop() ?? "";
        return { path: path.replace(/^\/+/, ""), name, kind: "folder" };
      }
      return { path: toRelative(data.path), name: data.name, kind: "file", size: data.size };
    },

    async read(path): Promise<ReadableStream<Uint8Array>> {
      // Raw media type streams the file directly (works for private repos too).
      const res = await contents(repoPath(path), "application/vnd.github.raw");
      if (!res.ok || !res.body) throw new Error(`github read failed: ${res.status}`);
      return res.body as ReadableStream<Uint8Array>;
    },

    async write(): Promise<StorageEntry> {
      throw new Error("github connector is read-only");
    },

    async remove(): Promise<void> {
      throw new Error("github connector is read-only");
    },
  };
}
