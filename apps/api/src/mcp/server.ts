import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Caller } from "@canopy/store";
import type { DriveDeps } from "./index";
import { registerTools } from "./tools";

/**
 * Build a fresh MCP server bound to one caller + drive. We construct one per
 * request (the Worker is stateless, so there is no shared session to reuse) and
 * register the tools as closures over the caller — keeping every tool call
 * scoped to that user's ACL.
 */
export function buildMcpServer(ctx: { caller: Caller; drive: DriveDeps; origin: string }): McpServer {
  const server = new McpServer(
    { name: "canopy-drive", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Canopy Drive: search, read, and manage the signed-in user's files. Use `search` to find files, then `fetch` to read one by id.",
    },
  );
  registerTools(server, ctx);
  return server;
}
