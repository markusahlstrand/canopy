import type { ListOptions, Page, StorageConnector, StorageEntry } from "@canopy/core";
import { sha256hex } from "@canopy/store";
import type { ContainerNamespace } from "./extract-container";

/**
 * A {@link StorageConnector} for the Cloudflare edge that proxies every call to
 * the per-user document container. The container joins THAT user's tailnet (with
 * their auth key) and talks to the NAS over FileStation — the only way a
 * connected Synology space can work at the edge, since a Worker isolate can't be
 * a tailnet peer.
 *
 * Tenancy: the container instance is keyed by a hash of the tailnet auth key, so
 * each tailnet identity gets its own isolated instance — user A's parser can
 * never reach user B's tailnet. The key never leaves the internal Worker→DO hop.
 *
 * The factory is synchronous (so it slots into the existing `connectorFor`); the
 * async work happens inside the methods, which `StorageConnector` already allows.
 */
export function createContainerSynologyConnector(
  ns: ContainerNamespace,
  config: Record<string, string>,
): StorageConnector {
  const authKey = config.tailscaleAuthKey ?? "";
  // The fields the service needs to rebuild the real connector. The auth key is
  // NOT here — the sidecar already used it to join the tailnet; this is just the
  // DSM address + credentials.
  const fwd: Record<string, string> = {};
  for (const k of ["tailscaleHost", "baseUrl", "account", "password", "otpCode", "shareRoot"]) {
    if (config[k]) fwd[k] = config[k]!;
  }

  /** One container instance per tailnet identity (hash of the auth key). */
  const instanceName = async () => `ts-${(await sha256hex(new TextEncoder().encode(authKey))).slice(0, 24)}`;

  const call = async (path: string, init: { body?: BodyInit; headers?: Record<string, string> }): Promise<Response> => {
    const stub = ns.get(ns.idFromName(await instanceName()));
    return stub.fetch(
      new Request(`http://docworker${path}`, {
        method: "POST",
        // The DO peeks this header to start the container on the right tailnet.
        headers: { "x-ts-authkey": authKey, ...init.headers },
        body: init.body,
      }),
    );
  };

  const failed = async (path: string, res: Response): Promise<Error> => {
    const detail = await res.text().catch(() => "");
    return new Error(`synology container ${path} → HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  };

  const json = async <T>(path: string, payload: unknown): Promise<T> => {
    const res = await call(path, {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    });
    if (!res.ok) throw await failed(path, res);
    return (await res.json()) as T;
  };

  return {
    id: "connector:synology",
    list: (path, opts?: ListOptions) =>
      json<Page<StorageEntry>>("/synology/list", { config: fwd, path, cursor: opts?.cursor, limit: opts?.limit }),
    stat: (path) => json<StorageEntry | null>("/synology/stat", { config: fwd, path }),
    async read(path): Promise<ReadableStream<Uint8Array>> {
      const res = await call("/synology/read", {
        body: JSON.stringify({ config: fwd, path }),
        headers: { "content-type": "application/json" },
      });
      if (!res.ok || !res.body) throw new Error(`synology container read → HTTP ${res.status}`);
      return res.body;
    },
    async write(path, body): Promise<StorageEntry> {
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
      const res = await call("/synology/write", {
        body: bytes as unknown as BodyInit,
        headers: { "x-syn-path": path, "x-syn-config": JSON.stringify(fwd), "content-type": "application/octet-stream" },
      });
      if (!res.ok) throw new Error(`synology container write → HTTP ${res.status}`);
      return (await res.json()) as StorageEntry;
    },
    remove: async (path) => {
      await json("/synology/remove", { config: fwd, path });
    },
    mkdir: async (path) => {
      await json("/synology/mkdir", { config: fwd, path });
    },
  };
}
