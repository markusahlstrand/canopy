import type { BranchInfo, BranchOps, Page, StorageConnector, StorageEntry } from "@canopy/core";

export * from "./providers";

export interface GithubConnectorConfig {
  owner: string;
  repo: string;
  /** Default "main". */
  branch?: string;
  /** Repo subdirectory this connector is rooted at, e.g. "documentation". */
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

interface GhBranch {
  name: string;
  protected?: boolean;
  commit: { sha: string };
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
 * drive and the documentation mount be read live from GitHub instead of being bundled
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

  const repoUrl = `https://api.github.com/repos/${config.owner}/${config.repo}`;

  async function contents(p: string, accept = "application/vnd.github+json"): Promise<Response> {
    const url = `${repoUrl}/contents/${encodePath(p)}?ref=${branch}`;
    return fetch(url, { headers: { ...apiHeaders, Accept: accept } });
  }

  /** GitHub answers errors as `{ message }`; surface that (with the status) so a bad
   *  token / branch / permission reaches the UI instead of a bare code. */
  async function ghError(res: Response, verb: string): Promise<Error> {
    let detail = "";
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) detail = `: ${body.message}`;
    } catch {
      /* non-JSON body — fall back to the status */
    }
    return new Error(`github ${verb} failed (${res.status})${detail}`);
  }

  // Branch management (git refs API). `list` also resolves the repo's default branch
  // (HEAD) so the UI can mark it undeletable; `create` forks from the named base ref
  // (or the connector's current branch); `remove` deletes a `heads/*` ref. Writes
  // need a token with `contents`/`repo` write scope — GitHub's 403/422 bubbles up.
  const branches: BranchOps = {
    async list(): Promise<BranchInfo[]> {
      // Default branch comes from the repo record; the branch list is paginated.
      const repoRes = await fetch(repoUrl, { headers: apiHeaders });
      if (!repoRes.ok) throw await ghError(repoRes, "branches");
      const defaultBranch = ((await repoRes.json()) as { default_branch?: string }).default_branch ?? "main";
      const out: BranchInfo[] = [];
      for (let page = 1; page <= 10; page++) {
        const res = await fetch(`${repoUrl}/branches?per_page=100&page=${page}`, { headers: apiHeaders });
        if (!res.ok) throw await ghError(res, "branches");
        const arr = (await res.json()) as GhBranch[];
        for (const b of arr) {
          out.push({
            name: b.name,
            isDefault: b.name === defaultBranch,
            current: b.name === branch,
            protected: b.protected,
            commitSha: b.commit?.sha,
          });
        }
        if (arr.length < 100) break; // last page
      }
      out.sort((a, b) =>
        a.isDefault !== b.isDefault ? (a.isDefault ? -1 : 1) : a.name.localeCompare(b.name),
      );
      return out;
    },

    async create(name: string, from?: string): Promise<void> {
      const ref = (from || branch).replace(/^refs\/heads\//, "");
      const tipRes = await fetch(`${repoUrl}/git/ref/heads/${encodePath(ref)}`, { headers: apiHeaders });
      if (!tipRes.ok) throw await ghError(tipRes, "create branch");
      const sha = ((await tipRes.json()) as { object?: { sha?: string } }).object?.sha;
      if (!sha) throw new Error(`github create branch failed: base ref "${ref}" has no commit`);
      const res = await fetch(`${repoUrl}/git/refs`, {
        method: "POST",
        headers: { ...apiHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ ref: `refs/heads/${name}`, sha }),
      });
      if (!res.ok) throw await ghError(res, "create branch");
    },

    async remove(name: string): Promise<void> {
      const res = await fetch(`${repoUrl}/git/refs/heads/${encodePath(name)}`, {
        method: "DELETE",
        headers: apiHeaders,
      });
      // 422 = ref doesn't exist; treat as already-gone so delete is idempotent.
      if (!res.ok && res.status !== 422) throw await ghError(res, "delete branch");
    },
  };

  return {
    id,
    branch,
    branches,

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
