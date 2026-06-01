import { createSynologyConnector, tailscaleBaseUrl, type SynologyConfig } from "@canopy/connector-synology";
import { drainToBytes } from "@canopy/docworker";
import type { StorageConnector } from "@canopy/core";
import { createTailnetFetch } from "./tailnet";

/** Largest source we'll pull before parsing — mirrors the parser's input cap. */
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

/** A file on a Synology NAS, reachable over the tailnet from this service. */
export interface SynologySource {
  /** Connector config — typically `{ account, password, tailscaleHost, shareRoot? }`. */
  config: SynologyConfig;
  /** Connector-relative path of the file, e.g. "Budgets/2026.xlsx". */
  path: string;
}

/**
 * Build a Synology connector whose FileStation calls egress over the tailnet
 * (via {@link createTailnetFetch} — the Tailscale sidecar). The tailnet identity
 * is the sidecar's, established from the per-user auth key the DO injected at
 * container start; this connector just rides the resulting proxy.
 */
export function synologyConnector(config: SynologyConfig): StorageConnector {
  // The low-level connector only resolves a base URL from `baseUrl`/`quickConnectId`;
  // the `tailscaleHost` → `http://host:5000` synthesis normally happens in the
  // plugin's create(), which the container bypasses. Do it here so a tailnet config
  // works. (`tailscaleBaseUrl` defaults a bare host to http on DSM's 5000.)
  const baseUrl = config.baseUrl || (config.tailscaleHost ? tailscaleBaseUrl(config.tailscaleHost) : undefined);
  return createSynologyConnector("docworker:synology", { ...config, baseUrl, fetchImpl: createTailnetFetch() });
}

/**
 * Read a Synology file's bytes over the tailnet. Returns null if the file is
 * larger than {@link MAX_SOURCE_BYTES}.
 */
export async function readSynologyBytes(src: SynologySource): Promise<Uint8Array | null> {
  const stream = await synologyConnector(src.config).read(src.path);
  const { bytes } = await drainToBytes(stream, MAX_SOURCE_BYTES);
  return bytes;
}

/** Last path segment, used as the file name for format detection. */
export function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
