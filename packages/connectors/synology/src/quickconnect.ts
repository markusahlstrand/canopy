/**
 * QuickConnect ID → base URL resolution.
 *
 * QuickConnect lets a NAS be reached without port-forwarding: Synology's
 * coordinator servers know, for a given QuickConnect ID, every way the box can
 * currently be reached — its LAN interfaces, a WAN/DDNS address if a port is
 * forwarded, and a relay tunnel as the always-works fallback. We ask the
 * coordinator, turn its answer into an ordered list of candidate base URLs, and
 * let the caller probe them and keep the first that responds.
 *
 * The coordinator protocol is undocumented and reverse-engineered; Synology can
 * change it. Parsing is therefore defensive — unknown/missing fields are skipped,
 * never thrown on — and {@link candidatesFromServerInfo} is kept pure so the
 * shape handling is unit-testable without a live NAS.
 */

/** Default global coordinator. Override for testing or a regional entry point. */
export const DEFAULT_COORDINATOR = "https://global.quickconnect.to";

export interface ResolveOptions {
  /** Coordinator base URL (no trailing slash). Defaults to {@link DEFAULT_COORDINATOR}. */
  coordinator?: string;
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Put LAN-interface candidates first. True when the resolver runs on the same
   * network as the NAS (self-hosted Node); false (default) for remote/edge, where
   * LAN IPs are unreachable and only WAN/DDNS/relay can work.
   */
  preferLan?: boolean;
}

/** "NULL"/empty are how the coordinator says "not set" — treat as absent. */
function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.toUpperCase() !== "NULL";
}

function httpsUrl(host: string, port?: number): string {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host; // bracket bare IPv6
  return port && port !== 443 ? `https://${h}:${port}` : `https://${h}`;
}

/**
 * Turn a coordinator `get_server_info` response into an ordered list of unique
 * candidate base URLs to try. Pure — no I/O — so it can be tested against
 * recorded response shapes.
 */
export function candidatesFromServerInfo(
  data: Record<string, unknown>,
  id: string,
  preferLan = false,
): string[] {
  const server = (data.server ?? {}) as Record<string, unknown>;
  const service = (data.service ?? {}) as Record<string, unknown>;
  const env = (data.env ?? {}) as Record<string, unknown>;
  const smartdns = (data.smartdns ?? {}) as Record<string, unknown>;

  const extPort = Number(service.ext_port) || undefined; // WAN-facing (port-forwarded) https port
  const intPort = Number(service.port) || undefined; // LAN https port (often 5001)

  const remote: string[] = [];
  const lan: string[] = [];

  // DDNS / fully-qualified name — the friendliest reachable name when set.
  if (present(server.ddns)) remote.push(httpsUrl(server.ddns, extPort));
  if (present(server.fqdn)) remote.push(httpsUrl(server.fqdn, extPort));

  // SmartDNS hostname (resolves to LAN when you're home, relay otherwise) — the
  // relay terminates on standard https, so no explicit WAN-forwarded port.
  if (present(smartdns.host)) remote.push(httpsUrl(smartdns.host));

  // Direct WAN IP, if a port is forwarded.
  const external = (server.external ?? {}) as Record<string, unknown>;
  if (present(external.ip) && extPort) remote.push(httpsUrl(external.ip, extPort));

  // Relay tunnel — the always-available fallback that needs no port-forwarding.
  if (present(service.relay_ip)) remote.push(httpsUrl(service.relay_ip, Number(service.relay_port) || undefined));
  const controlHost = present(env.control_host) ? env.control_host : "quickconnect.to";
  remote.push(httpsUrl(`${id}.${controlHost}`)); // generic tunnel name, last resort

  // LAN interfaces — reachable only on the same network (self-hosted Node).
  const interfaces = Array.isArray(server.interface) ? (server.interface as Record<string, unknown>[]) : [];
  for (const iface of interfaces) {
    if (present(iface.ip)) lan.push(httpsUrl(iface.ip, intPort));
    if (present(iface.ipv6)) {
      const v6 = iface.ipv6 as Record<string, unknown> | string;
      const addr = typeof v6 === "string" ? v6 : present((v6 as Record<string, unknown>).address) ? (v6 as Record<string, string>).address : null;
      if (addr) lan.push(httpsUrl(addr, intPort));
    }
  }

  const ordered = preferLan ? [...lan, ...remote] : [...remote, ...lan];
  return [...new Set(ordered)]; // de-dupe, preserve order
}

/**
 * Resolve a QuickConnect ID to an ordered list of candidate base URLs. Throws if
 * the coordinator can't be reached or reports the ID as unknown.
 */
export async function resolveQuickConnect(id: string, opts: ResolveOptions = {}): Promise<string[]> {
  const coordinator = opts.coordinator ?? DEFAULT_COORDINATOR;
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${coordinator}/Serv.php`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: 1,
      command: "get_server_info",
      stop_when_error: false,
      stop_when_success: false,
      id: "dsm_portal_https",
      serverID: id,
    }),
  });
  if (!res.ok) throw new Error(`QuickConnect coordinator HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, unknown>;
  // errno 0 = ok; 4 = unknown id; others = transient/coordinator errors.
  const errno = Number(data.errno ?? 0);
  if (errno !== 0) {
    throw new Error(errno === 4 ? `Unknown QuickConnect ID: ${id}` : `QuickConnect coordinator error ${errno}`);
  }
  const candidates = candidatesFromServerInfo(data, id, opts.preferLan);
  if (candidates.length === 0) throw new Error(`QuickConnect "${id}" returned no reachable address`);
  return candidates;
}
