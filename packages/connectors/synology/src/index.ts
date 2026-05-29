import type {
  ConnectorConfigField,
  Page,
  StorageConnector,
  StorageConnectorPlugin,
  StorageEntry,
} from "@canopy/core";
import { resolveQuickConnect } from "./quickconnect";

export * from "./quickconnect";

/**
 * Storage connector over a Synology DiskStation (DSM) via its FileStation Web
 * API. Reachable either directly (`baseUrl`, e.g. on the LAN or a public HTTPS
 * endpoint) or through a `quickConnectId` that the {@link resolveQuickConnect}
 * helper turns into a reachable address.
 *
 * Notes on the API: every call carries a session id (`_sid`) obtained from
 * `SYNO.API.Auth`; the connector logs in lazily on first use and re-authenticates
 * once if the session has expired (error 119). API paths/versions are discovered
 * via `SYNO.API.Info` so it works across DSM versions (entry.cgi vs the older
 * per-app cgis). Paths the connector exposes are POSIX-relative to `shareRoot`
 * (e.g. shareRoot "/home" + "photos/a.jpg" → the DSM path "/home/photos/a.jpg").
 */
export interface SynologyConfig {
  /** Direct base URL, e.g. "https://nas.example.com:5001". Wins over QuickConnect. */
  baseUrl?: string;
  /** QuickConnect ID — resolved to a base URL when `baseUrl` is absent. */
  quickConnectId?: string;
  account: string;
  password: string;
  /** One-time code, when the account has 2-step verification enabled. */
  otpCode?: string;
  /**
   * Shared folder this connector is rooted at, e.g. "/home" or "/photos". When
   * empty, the root listing enumerates the NAS's shared folders.
   */
  shareRoot?: string;
  /** Prefer LAN candidates when resolving QuickConnect (self-hosted on the LAN). */
  preferLan?: boolean;
  /** Coordinator override for QuickConnect resolution. */
  coordinator?: string;
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Error codes the FileStation API returns that we special-case. */
const SID_EXPIRED = 119;
const NO_SUCH_FILE = 408;

/** Preferred API versions, capped to what `SYNO.API.Info` reports the box supports. */
const PREFERRED_VERSION: Record<string, number> = {
  "SYNO.API.Auth": 6,
  "SYNO.FileStation.List": 2,
  "SYNO.FileStation.Download": 2,
  "SYNO.FileStation.Upload": 2,
  "SYNO.FileStation.Delete": 2,
  "SYNO.FileStation.CreateFolder": 2,
};

const DEFAULT_PATH: Record<string, string> = {
  "SYNO.API.Auth": "auth.cgi",
  default: "entry.cgi",
};

export class SynologyError extends Error {
  constructor(
    readonly code: number,
    readonly api: string,
  ) {
    super(`Synology ${api} failed: error ${code}`);
    this.name = "SynologyError";
  }
}

interface ApiEntry {
  path: string;
  version: number;
}

interface SynoFile {
  name: string;
  path: string;
  isdir: boolean;
  additional?: { size?: number; time?: { mtime?: number } };
}

function posixDirname(p: string): string {
  const clean = p.replace(/\/+$/, "");
  const i = clean.lastIndexOf("/");
  return i <= 0 ? "/" : clean.slice(0, i);
}
function posixBasename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() ?? "";
}

/**
 * Read a Synology API response as JSON. DSM always answers with JSON, so a body
 * that won't parse means we never reached DSM — typically an intermediary error
 * page (e.g. Cloudflare's plain-text "error code: 1003" when an edge runtime
 * fetches a Cloudflare-fronted address by IP). Surface that legibly instead of
 * letting a raw `JSON.parse` throw an opaque "Unexpected token …".
 */
async function readJson<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const snippet = text.trim().replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`Synology ${what}: expected JSON but got HTTP ${res.status} "${snippet || "(empty body)"}"`);
  }
}

export function createSynologyConnector(id: string, config: SynologyConfig): StorageConnector {
  const doFetch = config.fetchImpl ?? fetch;
  const shareRoot = (config.shareRoot ?? "").replace(/\/+$/, ""); // e.g. "/home"

  let baseUrl: string | null = config.baseUrl ? config.baseUrl.replace(/\/+$/, "") : null;
  let sid: string | null = null;
  let apis: Record<string, ApiEntry> | null = null;

  /** A connector-relative POSIX path → an absolute DSM FileStation path. */
  function toFsPath(rel: string): string {
    const clean = (rel ?? "").replace(/^\/+|\/+$/g, "");
    const joined = [shareRoot, clean].filter(Boolean).join("/");
    return joined || "/";
  }
  /** An absolute DSM path → the connector-relative path the host addresses it by. */
  function toRelative(full: string): string {
    const pfx = shareRoot ? `${shareRoot}/` : "/";
    return full.startsWith(pfx) ? full.slice(pfx.length) : full.replace(/^\/+/, "");
  }

  /** Pick the first candidate base URL whose API endpoint answers. */
  async function resolveBaseUrl(): Promise<string> {
    if (baseUrl) return baseUrl;
    if (!config.quickConnectId) throw new Error("synology connector needs a baseUrl or quickConnectId");
    const candidates = await resolveQuickConnect(config.quickConnectId, {
      coordinator: config.coordinator,
      preferLan: config.preferLan,
      fetchImpl: doFetch,
    });
    for (const candidate of candidates) {
      try {
        const ok = await probe(candidate);
        if (ok) {
          baseUrl = candidate;
          return baseUrl;
        }
      } catch {
        // try the next candidate
      }
    }
    throw new Error(`QuickConnect "${config.quickConnectId}": no candidate address responded`);
  }

  /** Cheap reachability check: does this host serve the DSM Web API? */
  async function probe(candidate: string): Promise<boolean> {
    const url = `${candidate}/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=SYNO.API.Auth`;
    const res = await doFetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return false;
    try {
      const body = (await res.json()) as { success?: boolean };
      return body.success === true;
    } catch {
      return false; // non-JSON (a proxy/CDN error page) → not a usable DSM endpoint
    }
  }

  /** Discover API paths + versions once (falls back to sane defaults). */
  async function discover(base: string): Promise<Record<string, ApiEntry>> {
    if (apis) return apis;
    const wanted = Object.keys(PREFERRED_VERSION).join(",");
    const url = `${base}/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=${encodeURIComponent(wanted)}`;
    const out: Record<string, ApiEntry> = {};
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(8000) });
      const body = (await res.json()) as { success?: boolean; data?: Record<string, { path?: string; maxVersion?: number }> };
      if (body.success && body.data) {
        for (const [api, info] of Object.entries(body.data)) {
          const version = Math.min(PREFERRED_VERSION[api] ?? 1, info.maxVersion ?? PREFERRED_VERSION[api] ?? 1);
          out[api] = { path: info.path ?? DEFAULT_PATH[api] ?? DEFAULT_PATH.default!, version };
        }
      }
    } catch {
      // discovery is best-effort; defaults below cover modern DSM
    }
    for (const api of Object.keys(PREFERRED_VERSION)) {
      out[api] ??= { path: DEFAULT_PATH[api] ?? DEFAULT_PATH.default!, version: PREFERRED_VERSION[api] ?? 1 };
    }
    apis = out;
    return out;
  }

  async function apiOf(api: string): Promise<ApiEntry> {
    const base = await resolveBaseUrl();
    return (await discover(base))[api]!;
  }

  async function login(): Promise<string> {
    const base = await resolveBaseUrl();
    const auth = (await discover(base))["SYNO.API.Auth"]!;
    const params = new URLSearchParams({
      api: "SYNO.API.Auth",
      version: String(auth.version),
      method: "login",
      account: config.account,
      passwd: config.password,
      session: "FileStation",
      format: "sid",
    });
    if (config.otpCode) params.set("otp_code", config.otpCode);
    const res = await doFetch(`${base}/webapi/${auth.path}?${params}`);
    const body = await readJson<{ success?: boolean; data?: { sid?: string }; error?: { code?: number } }>(res, "login");
    if (!body.success || !body.data?.sid) throw new SynologyError(body.error?.code ?? 0, "SYNO.API.Auth");
    sid = body.data.sid;
    return sid;
  }

  async function ensureSid(): Promise<string> {
    return sid ?? (await login());
  }

  /**
   * GET a FileStation method and return its `data`, refreshing the session once
   * if it expired. `notFoundCodes` map to `null` instead of throwing.
   */
  async function call<T>(api: string, method: string, params: Record<string, string>, notFoundCodes: number[] = []): Promise<T | null> {
    const { path, version } = await apiOf(api);
    const base = baseUrl!;
    const run = async (token: string): Promise<{ success: boolean; data?: T; code?: number }> => {
      const qs = new URLSearchParams({ api, version: String(version), method, ...params, _sid: token });
      const res = await doFetch(`${base}/webapi/${path}?${qs}`);
      const body = await readJson<{ success?: boolean; data?: T; error?: { code?: number } }>(res, `${api}.${method}`);
      return { success: !!body.success, data: body.data, code: body.error?.code };
    };

    let token = await ensureSid();
    let r = await run(token);
    if (!r.success && r.code === SID_EXPIRED) {
      sid = null;
      token = await login();
      r = await run(token);
    }
    if (!r.success) {
      if (r.code != null && notFoundCodes.includes(r.code)) return null;
      throw new SynologyError(r.code ?? 0, api);
    }
    return r.data ?? null;
  }

  function toEntry(f: SynoFile): StorageEntry {
    const mtime = f.additional?.time?.mtime;
    return {
      path: toRelative(f.path),
      name: f.name,
      kind: f.isdir ? "folder" : "file",
      size: f.isdir ? undefined : f.additional?.size,
      modifiedAt: mtime ? new Date(mtime * 1000).toISOString() : undefined,
    };
  }

  const ADDITIONAL = JSON.stringify(["size", "time", "type"]);

  return {
    id,

    async list(path): Promise<Page<StorageEntry>> {
      // Root with no shareRoot: enumerate the NAS's shared folders as the top level.
      if (!shareRoot && !(path ?? "").replace(/^\/+|\/+$/g, "")) {
        const data = await call<{ shares?: { name: string; path: string }[] }>("SYNO.FileStation.List", "list_share", {
          additional: ADDITIONAL,
        });
        const items: StorageEntry[] = (data?.shares ?? []).map((s) => ({ path: s.name, name: s.name, kind: "folder" }));
        items.sort((a, b) => a.name.localeCompare(b.name));
        return { items };
      }
      const data = await call<{ files?: SynoFile[] }>(
        "SYNO.FileStation.List",
        "list",
        { folder_path: toFsPath(path), additional: ADDITIONAL },
        [NO_SUCH_FILE],
      );
      if (!data) return { items: [] }; // not-yet-created folder lists empty
      const items = (data.files ?? []).map(toEntry);
      items.sort((a, b) => (a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : a.name.localeCompare(b.name)));
      return { items };
    },

    async stat(path): Promise<StorageEntry | null> {
      const data = await call<{ files?: SynoFile[] }>(
        "SYNO.FileStation.List",
        "getinfo",
        { path: JSON.stringify([toFsPath(path)]), additional: ADDITIONAL },
        [NO_SUCH_FILE],
      );
      const f = data?.files?.[0];
      return f ? toEntry(f) : null;
    },

    async read(path): Promise<ReadableStream<Uint8Array>> {
      const { path: cgi, version } = await apiOf("SYNO.FileStation.Download");
      const token = await ensureSid();
      const qs = new URLSearchParams({
        api: "SYNO.FileStation.Download",
        version: String(version),
        method: "download",
        path: JSON.stringify([toFsPath(path)]),
        mode: "open",
        _sid: token,
      });
      const res = await doFetch(`${baseUrl}/webapi/${cgi}?${qs}`);
      if (!res.ok || !res.body) throw new Error(`synology read failed: ${res.status}`);
      return res.body as ReadableStream<Uint8Array>;
    },

    async write(path, body): Promise<StorageEntry> {
      const { path: cgi, version } = await apiOf("SYNO.FileStation.Upload");
      const token = await ensureSid();
      const fsPath = toFsPath(path);
      const dir = posixDirname(fsPath);
      const name = posixBasename(fsPath);
      // FileStation upload is multipart; buffer the body into a Blob (the API
      // needs a discrete part, not a chunked stream).
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
      const form = new FormData();
      form.set("api", "SYNO.FileStation.Upload");
      form.set("version", String(version));
      form.set("method", "upload");
      form.set("path", dir);
      form.set("create_parents", "true");
      form.set("overwrite", "true");
      form.set("file", new Blob([bytes as BlobPart]), name);
      const res = await doFetch(`${baseUrl}/webapi/${cgi}?_sid=${encodeURIComponent(token)}`, { method: "POST", body: form });
      const result = await readJson<{ success?: boolean; error?: { code?: number } }>(res, "SYNO.FileStation.Upload");
      if (!result.success) throw new SynologyError(result.error?.code ?? 0, "SYNO.FileStation.Upload");
      return { path: toRelative(fsPath), name, kind: "file", size: bytes.byteLength, modifiedAt: new Date().toISOString() };
    },

    async remove(path): Promise<void> {
      await call("SYNO.FileStation.Delete", "delete", { path: JSON.stringify([toFsPath(path)]), recursive: "true" });
    },

    async mkdir(path): Promise<void> {
      const fsPath = toFsPath(path);
      await call("SYNO.FileStation.CreateFolder", "create", {
        folder_path: posixDirname(fsPath),
        name: posixBasename(fsPath),
        force_parent: "true",
      });
    },
  };
}

const configFields: ConnectorConfigField[] = [
  {
    key: "mode",
    label: "Connection",
    type: "select",
    required: true,
    options: [
      { value: "direct", label: "Direct address (LAN or public HTTPS)" },
      { value: "quickconnect", label: "QuickConnect ID" },
    ],
  },
  { key: "baseUrl", label: "Address (e.g. https://nas.example.com:5001)", type: "url" },
  { key: "quickConnectId", label: "QuickConnect ID", type: "string" },
  { key: "account", label: "DSM account", type: "string", required: true },
  { key: "password", label: "DSM password", type: "secret", required: true },
  { key: "otpCode", label: "One-time code (only if 2-step verification is on)", type: "secret" },
  { key: "shareRoot", label: "Shared folder, e.g. /home or /photos (blank = list all shares)", type: "string" },
];

export const synologyConnectorPlugin: StorageConnectorPlugin = {
  type: "synology",
  label: "Synology (DSM)",
  configFields,
  create(id, config) {
    const account = String(config.account ?? "");
    const password = String(config.password ?? "");
    const baseUrl = config.baseUrl ? String(config.baseUrl) : undefined;
    const quickConnectId = config.quickConnectId ? String(config.quickConnectId) : undefined;
    if (!account || !password) throw new Error("synology connector requires 'account' and 'password'");
    if (!baseUrl && !quickConnectId) throw new Error("synology connector requires a 'baseUrl' or 'quickConnectId'");
    return createSynologyConnector(id, {
      account,
      password,
      baseUrl,
      quickConnectId,
      otpCode: config.otpCode ? String(config.otpCode) : undefined,
      shareRoot: config.shareRoot ? String(config.shareRoot) : undefined,
      preferLan: config.preferLan === true || config.preferLan === "true",
    });
  },
};
