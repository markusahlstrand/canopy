import type { Db } from "./db";

/**
 * MCP clients: the AI assistants (Claude, ChatGPT, editors) a user has connected
 * to their drive over the remote MCP server. Because that server is stateless —
 * a fresh instance per request, the bearer token verified then discarded — this
 * table is the only durable record that a connection ever happened. We upsert one
 * row per (user, connecting app) and bump `last_seen_at` on every request, so the
 * Settings panel can show what's connected and how recently it was active.
 */

export interface McpClient {
  /** The connecting app's id: the token's `azp`/`client_id`, or a slug of the clientInfo name. */
  clientId: string;
  /** Friendly name from the MCP `initialize` handshake (e.g. "Claude"), when learned. */
  name: string | null;
  version: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * Record an MCP request from `clientId` for `userSub`, bumping `last_seen_at`.
 * `name`/`version` arrive only on the `initialize` handshake; later calls omit
 * them, so `COALESCE` keeps the name we already learned rather than nulling it.
 */
export async function recordMcpClient(
  db: Db,
  userSub: string,
  clientId: string,
  info?: { name?: string | null; version?: string | null },
): Promise<void> {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO mcp_clients (user_sub, client_id, name, version, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_sub, client_id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       name         = COALESCE(excluded.name, mcp_clients.name),
       version      = COALESCE(excluded.version, mcp_clients.version)`,
    [userSub, clientId, info?.name ?? null, info?.version ?? null, now, now],
  );
}

/** The assistants a user has connected, most recently active first. */
export async function listMcpClients(db: Db, userSub: string): Promise<McpClient[]> {
  const rows = await db.all<{
    client_id: string;
    name: string | null;
    version: string | null;
    first_seen_at: string;
    last_seen_at: string;
  }>(
    "SELECT client_id, name, version, first_seen_at, last_seen_at FROM mcp_clients WHERE user_sub = ? ORDER BY last_seen_at DESC",
    [userSub],
  );
  return rows.map((r) => ({
    clientId: r.client_id,
    name: r.name,
    version: r.version,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
  }));
}
