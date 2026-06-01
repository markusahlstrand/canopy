import type { Context } from "hono";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Caller } from "@canopy/store";
import type { DriveDeps, MCPEnv } from "./index";
import { buildMcpServer } from "./server";

const jsonRpcError = (id: string | number | null, code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  id,
  error: { code, message },
});

/** A JSON-RPC request (expects a response) vs a notification/response (does not). */
function isRequest(m: unknown): m is { id: string | number; method: string } {
  return (
    !!m &&
    typeof m === "object" &&
    "method" in m &&
    "id" in m &&
    (m as { id: unknown }).id !== undefined &&
    (m as { id: unknown }).id !== null
  );
}

/** The `clientInfo` from an `initialize` message in the batch, if present (only the
 *  handshake carries it; later tool calls don't). Names the connecting assistant. */
function clientInfoOf(messages: unknown[]): { name?: string; version?: string } | undefined {
  for (const m of messages) {
    if (m && typeof m === "object" && (m as { method?: unknown }).method === "initialize") {
      const ci = (m as { params?: { clientInfo?: { name?: unknown; version?: unknown } } }).params?.clientInfo;
      if (ci && typeof ci === "object") {
        return {
          name: typeof ci.name === "string" ? ci.name : undefined,
          version: typeof ci.version === "string" ? ci.version : undefined,
        };
      }
    }
  }
  return undefined;
}

/** A stable id for the connecting app: the token's client id, else a slug of the
 *  clientInfo name. Returns undefined when neither is known (so we record nothing
 *  rather than collapsing distinct assistants into one "unknown" row). */
function clientKey(tokenClientId: string | undefined, info: { name?: string } | undefined): string | undefined {
  if (tokenClientId) return tokenClientId;
  const slug = info?.name?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || undefined;
}

/**
 * Handle one MCP request over Streamable HTTP in **stateless JSON mode**. The
 * SDK's StreamableHTTPServerTransport is built for Node's http server, so instead
 * of shimming it onto the Worker runtime we drive an `McpServer` directly through
 * an in-memory transport pair: feed it the POSTed JSON-RPC message(s), correlate
 * the response(s) by id, and return them as a single JSON body. No SSE — these
 * tools are plain request/response — and no session state, which matches the
 * stateless Worker (a fresh server per request, see {@link buildMcpServer}).
 */
export async function handleMcp(c: Context<MCPEnv>, drive: DriveDeps): Promise<Response> {
  const caller: Caller = c.get("mcpCaller");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(jsonRpcError(null, -32700, "Parse error"), 400);
  }

  const server = buildMcpServer({ caller, drive, origin: new URL(c.req.url).origin });
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTx);

  // Server responses come back on the client side of the pair; resolve each
  // pending request by its JSON-RPC id.
  const pending = new Map<string | number, (m: JSONRPCMessage) => void>();
  clientTx.onmessage = (msg: JSONRPCMessage) => {
    const id = (msg as { id?: string | number }).id;
    if (id !== undefined && id !== null && pending.has(id)) {
      pending.get(id)!(msg);
      pending.delete(id);
    }
  };

  const messages = Array.isArray(body) ? body : [body];

  // Best-effort: note which assistant is connected (and that it's active now), so
  // Settings can show it. Stateless server → this table is the only such trace.
  // Must never break a tool call, so it's wrapped and the failure swallowed.
  try {
    const info = clientInfoOf(messages);
    const key = clientKey(c.get("mcpClientId"), info);
    if (key) await drive.service.recordMcpClient(caller.sub, key, info);
  } catch {
    /* connection tracking is non-essential — ignore */
  }

  const responses: JSONRPCMessage[] = [];
  try {
    await Promise.all(
      messages.map(async (m) => {
        if (!isRequest(m)) {
          // Notification (e.g. notifications/initialized) — no reply expected.
          await clientTx.send(m as JSONRPCMessage);
          return;
        }
        const response = await new Promise<JSONRPCMessage>((resolve) => {
          pending.set(m.id, resolve);
          void clientTx.send(m as JSONRPCMessage);
        });
        responses.push(response);
      }),
    );
  } finally {
    await server.close().catch(() => {});
  }

  // No responses (the POST carried only notifications): 202 Accepted, empty body.
  if (responses.length === 0) return c.body(null, 202);
  return c.json(Array.isArray(body) ? responses : responses[0]);
}
