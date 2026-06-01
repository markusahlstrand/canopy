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
        "Canopy Drive: search, read, and manage the signed-in user's files. Use `search` to find files, then `fetch` to " +
        "read one by id. For large files, `get_outline` returns structure (page count, headings/TOC) without the full " +
        "text, and `fetch` takes `offset`/`limit` to page through content — check `has_more` so you never miss a truncated " +
        "tail. For spreadsheets, prefer `extract_tables` to get structured rows/columns instead of flattened text.",
    },
  );
  registerTools(server, ctx);
  return server;
}
