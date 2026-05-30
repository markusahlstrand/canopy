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
